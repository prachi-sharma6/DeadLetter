import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { ZodType, z } from 'zod';
import {
  EmailNotVerifiedError,
  UnauthenticatedError,
  requireOrgAccess,
  requireProjectAccess,
  resolveSession,
  DomainError,
  BadRequestError,
  NotFoundError,
} from '@deadletter/core';
import type { MemberRole } from '@deadletter/shared';
import type { AppDeps } from './context';
import { RULES, type RateLimiter, type RateLimitRule } from './rate-limit';
import { clearSessionCookie, readSessionToken } from './session-cookie';

/**
 * Who may call a route:
 *  - public:  anyone (still rate limited and CSRF-checked when it changes state)
 *  - user:    a signed-in user
 *  - org:     a member of `:orgId` with at least `role`
 *  - project: a member of the organization owning `:projectId` with at least `role`
 * Non-members of an org/project get 404, never 403, so ids cannot be probed. The isolation test suite reads this
 * registry and proves that for every org/project route.
 */
export type RouteScope = 'public' | 'user' | 'org' | 'project';

export interface RouteDef {
  method: 'get' | 'post' | 'patch' | 'delete';
  /** Express path relative to /api, e.g. `/orgs/:orgId/members`. */
  path: string;
  scope: RouteScope;
  /** Minimum role for org/project routes. */
  role?: MemberRole;
  /** Require a verified email (enforced only when email delivery is configured). */
  verified?: boolean;
  /** Extra rate limits: return the rule and subject, or null to skip. */
  limits?: ((req: Request) => [RateLimitRule, string] | null)[];
  summary: string;
  /** Return the response data (sent as `{ data }`), or send the response yourself and return it. */
  handler: (req: Request, res: Response, deps: AppDeps) => unknown;
}

export const route = (def: RouteDef) => def;

export class ValidationError extends DomainError {
  constructor(fields: Record<string, string>) {
    const first = Object.entries(fields)[0];
    super('VALIDATION_ERROR', 400, first ? `${first[0]}: ${first[1]}` : 'Invalid request', { fields });
  }
}

/** Validate input with a shared Zod schema; failures become a 400 listing the first problem per field. */
export function parse<S extends ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input ?? {});
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const issue of r.error.issues) fields[issue.path.join('.') || '_'] ??= issue.message;
  throw new ValidationError(fields);
}

export const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ data });

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * CSRF defence for cookie-authenticated state changes: the browser-sent Origin (or Referer, if Origin is missing) must
 * be our own origin. Combined with SameSite=Lax session cookies this blocks cross-site form posts and fetches.
 */
export function csrfGuard(appOrigin: string): RequestHandler {
  return (req, _res, next) => {
    if (!UNSAFE.has(req.method)) return next();
    const origin =
      req.get('origin') ??
      (() => {
        try {
          return new URL(req.get('referer') ?? '').origin;
        } catch {
          return undefined;
        }
      })();
    if (origin !== appOrigin) return next(new DomainError('CSRF_REJECTED', 403, 'Cross-site request rejected'));
    next();
  };
}

function limit(limiter: RateLimiter, pick: (req: Request) => [RateLimitRule, string] | null): RequestHandler {
  return async (req, res, next) => {
    const picked = pick(req);
    if (!picked) return next();
    const [rule, subject] = picked;
    const r = await limiter.hit(rule, subject);
    if (r.allowed) return next();
    res.setHeader('retry-after', String(Math.ceil(r.retryAfterMs / 1000)));
    next(new DomainError('RATE_LIMITED', 429, 'Too many requests. Please wait and try again.'));
  };
}

/** Attach the signed-in user (if the cookie holds a valid session) without requiring one. */
export function sessionLoader(deps: AppDeps): RequestHandler {
  return async (req, res, next) => {
    const token = readSessionToken(req, deps.config);
    if (!token) return next();
    const resolved = await resolveSession(deps.db, token);
    if (resolved) req.auth = resolved;
    else clearSessionCookie(res, deps.config); // stale cookie: remove it
    next();
  };
}

export function buildRouter(routes: RouteDef[], deps: AppDeps, limiter: RateLimiter): Router {
  const router = Router();
  router.use(limit(limiter, (req) => [RULES.globalIp, req.ip ?? 'unknown']));
  router.use(sessionLoader(deps));
  router.use(csrfGuard(deps.config.APP_ORIGIN));

  for (const def of routes) {
    const idParams = [...def.path.matchAll(/:(\w+Id)\b/g)].map((m) => m[1]!);
    const chain: RequestHandler[] = [
      // Malformed ids are "not found", not a database error.
      (req, _res, next) =>
        next(idParams.some((p) => !UUID.test(String(req.params[p]))) ? new NotFoundError('Resource') : undefined),
      ...(def.limits ?? []).map((pick) => limit(limiter, pick)),
    ];
    if (def.scope !== 'public') {
      chain.push((req, _res, next) => next(req.auth ? undefined : new UnauthenticatedError()));
    }
    if (def.scope === 'org') {
      chain.push(async (req, _res, next) => {
        req.orgAccess = await requireOrgAccess(
          deps.db,
          String(req.params.orgId),
          req.auth!.user.id,
          def.role ?? 'VIEWER',
        );
        next();
      });
    }
    if (def.scope === 'project') {
      chain.push(async (req, _res, next) => {
        req.projectAccess = await requireProjectAccess(
          deps.db,
          String(req.params.projectId),
          req.auth!.user.id,
          def.role ?? 'VIEWER',
        );
        next();
      });
    }
    if (def.verified) {
      chain.push((req, _res, next) =>
        next(
          deps.identity.mailer.configured && !req.auth!.user.emailVerifiedAt ? new EmailNotVerifiedError() : undefined,
        ),
      );
    }
    chain.push(async (req: Request, res: Response, next: NextFunction) => {
      const result = await def.handler(req, res, deps);
      if (!res.headersSent && result !== undefined) ok(res, result);
      else if (!res.headersSent) next(new BadRequestError('NO_RESPONSE', 'Handler produced no response'));
    });
    router[def.method](def.path, ...chain);
  }
  return router;
}
