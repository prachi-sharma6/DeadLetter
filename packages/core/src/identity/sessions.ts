import type { Db, Session, User } from '@deadletter/db';
import { hashToken, newToken } from './crypto';

/** A session expires after 30 days without use; each use (at most every 10 minutes) pushes expiry forward. */
export const SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60_000;
/** No session lives longer than this, however active it is. */
export const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60_000;
const TOUCH_EVERY_MS = 10 * 60_000;

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

/** Create a session. The raw token goes into the cookie and is never stored; the database keeps its SHA-256. */
export async function createSession(db: Db, userId: string, meta: SessionMeta = {}, now = new Date()) {
  const token = newToken();
  const session = await db.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      userAgent: meta.userAgent?.slice(0, 300),
      ip: meta.ip,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_IDLE_TTL_MS),
    },
  });
  return { token, session };
}

export interface ResolvedSession {
  session: Session;
  user: User;
}

/**
 * Look up the session for a cookie token. Returns null for unknown, revoked, idle-expired or too-old sessions.
 * Active sessions slide their idle expiry, writing at most once per 10 minutes.
 */
export async function resolveSession(db: Db, token: string, now = new Date()): Promise<ResolvedSession | null> {
  if (!token || token.length > 200) return null;
  const found = await db.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!found || found.revokedAt || found.expiresAt <= now) return null;
  if (now.getTime() - found.createdAt.getTime() > SESSION_ABSOLUTE_TTL_MS) return null;

  const { user, ...session } = found;
  if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    const absoluteEnd = session.createdAt.getTime() + SESSION_ABSOLUTE_TTL_MS;
    const expiresAt = new Date(Math.min(now.getTime() + SESSION_IDLE_TTL_MS, absoluteEnd));
    await db.session.update({ where: { id: session.id }, data: { lastSeenAt: now, expiresAt } });
    return { session: { ...session, lastSeenAt: now, expiresAt }, user };
  }
  return { session, user };
}

export async function revokeSession(db: Db, userId: string, sessionId: string): Promise<boolean> {
  const r = await db.session.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return r.count === 1;
}

/** Sign out everywhere else (password change, "log out other devices"). Returns how many were revoked. */
export async function revokeOtherSessions(db: Db, userId: string, keepSessionId?: string): Promise<number> {
  const r = await db.session.updateMany({
    where: { userId, revokedAt: null, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
  return r.count;
}

export async function listActiveSessions(db: Db, userId: string, now = new Date()) {
  return db.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true, userAgent: true, ip: true, createdAt: true, lastSeenAt: true, expiresAt: true },
  });
}

/** Retention: drop sessions that ended more than 7 days ago. */
export async function pruneSessions(db: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  const r = await db.session.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
  });
  return r.count;
}
