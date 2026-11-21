import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Request, type RequestHandler } from 'express';
import compression from 'compression';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { pingDb } from '@deadletter/db';
import { DomainError } from '@deadletter/core';
import { WORKER_STALE_MS, WORKERS_KEY, withTimeout } from '@deadletter/runtime';
import type { AppDeps } from './http/context';
import { RateLimiter } from './http/rate-limit';
import { buildRouter } from './http/registry';
import { routes } from './routes';

export type { AppDeps };

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
const CHECK_TIMEOUT_MS = 2_000;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function check(fn: () => Promise<unknown>): Promise<{ ok: boolean; latencyMs: number }> {
  const t0 = performance.now();
  try {
    await withTimeout(fn(), CHECK_TIMEOUT_MS);
    return { ok: true, latencyMs: Math.round(performance.now() - t0) };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - t0) };
  }
}

export function createApp(deps: AppDeps) {
  const { config, logger, db, redis } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY === 'private' ? 'loopback, linklocal, uniquelocal' : config.TRUST_PROXY);

  const requestId: RequestHandler = (req, res, next) => {
    const incoming = req.header('x-request-id');
    req.id = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.id);
    next();
  };
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as Request).id,
      autoLogging: { ignore: (req) => (req as Request).url?.startsWith('/api/health') ?? false },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url.split('?')[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          // Only force HTTPS sub-requests in production; locally the built app is served over plain http.
          upgradeInsecureRequests: config.NODE_ENV === 'production' ? [] : null,
        },
      },
      strictTransportSecurity: config.NODE_ENV === 'production',
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));

  // Liveness: the process is up. Never touches dependencies, so a flaky Redis can't trigger restart loops.
  // TEMPORARY diagnostic (remove after verifying client-IP detection on Render): shows the caller only its own
  // forwarding headers and the IP the app derived from them.
  app.get('/api/debug/client-ip', (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.json({
      derivedIp: req.ip,
      ips: req.ips,
      xForwardedFor: req.get('x-forwarded-for') ?? null,
      cfConnectingIp: req.get('cf-connecting-ip') ?? null,
      trueClientIp: req.get('true-client-ip') ?? null,
    });
  });

  app.get('/api/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness: dependencies reachable. Used by uptime monitors and the platform's traffic routing.
  app.get('/api/health', async (_req, res) => {
    const [database, redisCheck] = await Promise.all([check(() => pingDb(db)), check(() => redis.ping())]);
    const workers = await withTimeout(
      redis.zcount(WORKERS_KEY, Date.now() - WORKER_STALE_MS, '+inf'),
      CHECK_TIMEOUT_MS,
    ).then(
      (n) => n,
      () => null,
    );
    const ok = database.ok && redisCheck.ok;
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      version: config.GIT_SHA,
      checks: { database, redis: redisCheck },
      workers,
      time: new Date().toISOString(),
    });
  });

  // Console API (cookie sessions). Every route is declared in ./routes with its access scope.
  app.use('/api', buildRouter(routes, deps, new RateLimiter(redis, logger, config.RATE_LIMITS === 'on')));

  app.use('/api', (req, _res, next) => next(new HttpError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`)));

  // Serve the built SPA from the same origin, so session cookies stay first-party and no CORS is needed.
  if (config.WEB_DIST_DIR) {
    const dir = path.resolve(config.WEB_DIST_DIR);
    if (!existsSync(path.join(dir, 'index.html'))) throw new Error(`WEB_DIST_DIR has no index.html: ${dir}`);
    app.use('/assets', express.static(path.join(dir, 'assets'), { immutable: true, maxAge: '1y', index: false }));
    app.use(express.static(dir, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => {
      res.setHeader('cache-control', 'no-cache');
      res.sendFile(path.join(dir, 'index.html'));
    });
  }

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    const e = err as Error & { status?: number; type?: string };
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong on our side';
    let details: unknown;
    if (err instanceof HttpError) ({ status, code, message } = err);
    else if (err instanceof DomainError) ({ httpStatus: status, code, message, details } = err);
    else if (e.type === 'entity.too.large')
      [status, code, message] = [413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'];
    else if (e.type === 'entity.parse.failed')
      [status, code, message] = [400, 'INVALID_JSON', 'Request body is not valid JSON'];
    else req.log.error({ err: e.stack }, 'unhandled error');
    // 5xx responses never include internals; the request id links the user's report to our logs.
    res.status(status).json({ error: { code, message, ...(details ? { details } : {}), requestId: req.id } });
  };
  app.use(errorHandler);
  return app;
}
