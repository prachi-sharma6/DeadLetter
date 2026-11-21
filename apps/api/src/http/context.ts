import type { Request } from 'express';
import type { PrismaClient, Session, User } from '@deadletter/db';
import type { Actor, IdentityDeps, OrgAccess, ProjectAccess } from '@deadletter/core';
import type { Logger, Redis } from '@deadletter/runtime';
import type { ApiConfig } from '../config';

export interface AppDeps {
  config: ApiConfig;
  logger: Logger;
  db: PrismaClient;
  redis: Redis;
  identity: IdentityDeps;
}

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
    auth?: { user: User; session: Session };
    orgAccess?: OrgAccess;
    projectAccess?: ProjectAccess;
  }
}

export function requireAuth(req: Request): { user: User; session: Session; actor: Actor } {
  if (!req.auth) throw new Error('route registered without authentication'); // programming error, never user input
  return {
    ...req.auth,
    actor: { userId: req.auth.user.id, label: `user:${req.auth.user.id}`, requestId: req.id, ip: req.ip },
  };
}

export function requireOrg(req: Request): OrgAccess {
  if (!req.orgAccess) throw new Error('route registered without org access');
  return req.orgAccess;
}

export function requireProject(req: Request): ProjectAccess {
  if (!req.projectAccess) throw new Error('route registered without project access');
  return req.projectAccess;
}

/** Metadata recorded with sessions and audit entries. */
export const requestMeta = (req: Request) => ({ ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id });
