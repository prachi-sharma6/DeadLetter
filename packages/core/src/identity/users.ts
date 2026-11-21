import { isUniqueViolation, type EmailTokenPurpose, type PrismaClient, type User } from '@deadletter/db';
import { writeAudit, userActor, type Actor } from '../audit';
import { resetPasswordMessage, verifyEmailMessage } from '../email/templates';
import type { Mailer } from '../email/mailer';
import { BadRequestError, DomainError, InvalidStateError, UnauthenticatedError } from '../errors';
import { burnPasswordCheck, hashPassword, hashToken, newToken, verifyPassword } from './crypto';
import { createSession, revokeOtherSessions, type SessionMeta } from './sessions';
import { makeSlug } from './slug';

export interface IdentityDeps {
  db: PrismaClient;
  mailer: Mailer;
  /** Public origin used to build links in emails, e.g. https://deadletter.onrender.com */
  appOrigin: string;
  /** Log email-delivery problems without failing the request that triggered the email. */
  onEmailError?: (err: unknown, purpose: string) => void;
}

const VERIFY_TTL_MS = 24 * 60 * 60_000;
const RESET_TTL_MS = 60 * 60_000;

/** Fields that are safe to send to the browser. Never includes the password hash. */
export const publicUser = (u: User) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  emailVerified: u.emailVerifiedAt !== null,
  createdAt: u.createdAt,
});
export type PublicUser = ReturnType<typeof publicUser>;

class EmailTakenError extends DomainError {
  constructor() {
    super('EMAIL_TAKEN', 409, 'An account with this email already exists');
  }
}

function assertPasswordNotEmail(password: string, email: string) {
  const local = email.split('@')[0] ?? '';
  if (local.length >= 4 && password.toLowerCase().includes(local.toLowerCase())) {
    throw new BadRequestError('WEAK_PASSWORD', 'Your password must not contain your email address', {
      fields: { password: 'Must not contain your email address' },
    });
  }
}

async function issueEmailToken(deps: IdentityDeps, userId: string, purpose: EmailTokenPurpose, ttlMs: number) {
  const token = newToken();
  // Only the newest link of each kind works: older unused ones are retired.
  await deps.db.emailToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } });
  await deps.db.emailToken.create({
    data: { userId, purpose, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) },
  });
  return token;
}

async function sendSafely(deps: IdentityDeps, purpose: string, send: () => Promise<void>): Promise<boolean> {
  if (!deps.mailer.configured) return false;
  try {
    await send();
    return true;
  } catch (err) {
    deps.onEmailError?.(err, purpose);
    return false;
  }
}

/** Consume a single-use email token. Expired, used, unknown and wrong-purpose tokens all fail the same way. */
async function consumeEmailToken(deps: IdentityDeps, token: string, purpose: EmailTokenPurpose) {
  const now = new Date();
  const row = await deps.db.emailToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt <= now) {
    throw new BadRequestError('INVALID_TOKEN', 'This link is invalid or has expired');
  }
  const claimed = await deps.db.emailToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
  if (claimed.count !== 1) throw new BadRequestError('INVALID_TOKEN', 'This link is invalid or has expired');
  return row;
}

// ───────────────────────────── sign up / sign in ─────────────────────────────

/**
 * Create an account with its own organization (the user is OWNER), start a session and send the verification email.
 * An email failure never fails sign-up: the user can request a new link.
 */
export async function signup(
  deps: IdentityDeps,
  input: { name: string; email: string; password: string },
  meta: SessionMeta & { requestId?: string } = {},
) {
  assertPasswordNotEmail(input.password, input.email);
  const passwordHash = await hashPassword(input.password);
  let user: User;
  try {
    user = await deps.db.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { email: input.email, name: input.name, passwordHash } });
      const org = await tx.organization.create({
        data: { name: `${input.name}'s workspace`, slug: makeSlug(input.name) },
      });
      await tx.membership.create({ data: { orgId: org.id, userId: u.id, role: 'OWNER' } });
      const actor = userActor(u.id, { requestId: meta.requestId, ip: meta.ip });
      await writeAudit(tx, actor, { action: 'user.signed_up', orgId: org.id, targetType: 'user', targetId: u.id });
      return u;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new EmailTakenError();
    throw err;
  }
  const verifyToken = await issueEmailToken(deps, user.id, 'VERIFY_EMAIL', VERIFY_TTL_MS);
  const emailSent = await sendSafely(deps, 'verify_email', () =>
    deps.mailer.send(verifyEmailMessage(user.email, user.name, `${deps.appOrigin}/verify-email?token=${verifyToken}`)),
  );
  const { token, session } = await createSession(deps.db, user.id, meta);
  return { user, sessionToken: token, sessionId: session.id, emailSent };
}

/** Same error and the same work (one Argon2 verification) whether or not the account exists. */
export async function login(
  deps: IdentityDeps,
  input: { email: string; password: string },
  meta: SessionMeta & { requestId?: string } = {},
) {
  const user = await deps.db.user.findUnique({ where: { email: input.email } });
  const ok = user
    ? await verifyPassword(user.passwordHash, input.password)
    : (await burnPasswordCheck(input.password), false);
  if (!user || !ok) {
    await writeAudit(
      deps.db,
      { label: user ? `user:${user.id}` : 'anonymous', requestId: meta.requestId, ip: meta.ip },
      { action: 'user.login_failed', result: 'FAILURE', metadata: { email: input.email } },
    );
    throw new UnauthenticatedError('Incorrect email or password');
  }
  const { token, session } = await createSession(deps.db, user.id, meta);
  await writeAudit(deps.db, userActor(user.id, { requestId: meta.requestId, ip: meta.ip }), {
    action: 'user.logged_in',
    targetType: 'session',
    targetId: session.id,
  });
  return { user, sessionToken: token, sessionId: session.id };
}

// ───────────────────────────── email verification & password reset ─────────────────────────────

export async function verifyEmail(deps: IdentityDeps, token: string, meta: { requestId?: string; ip?: string } = {}) {
  const row = await consumeEmailToken(deps, token, 'VERIFY_EMAIL');
  const user = await deps.db.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } });
  await writeAudit(deps.db, userActor(user.id, meta), {
    action: 'user.email_verified',
    targetType: 'user',
    targetId: user.id,
  });
  return user;
}

export async function resendVerification(deps: IdentityDeps, user: User) {
  if (user.emailVerifiedAt) return { alreadyVerified: true, emailSent: false, emailConfigured: deps.mailer.configured };
  const token = await issueEmailToken(deps, user.id, 'VERIFY_EMAIL', VERIFY_TTL_MS);
  const emailSent = await sendSafely(deps, 'verify_email', () =>
    deps.mailer.send(verifyEmailMessage(user.email, user.name, `${deps.appOrigin}/verify-email?token=${token}`)),
  );
  return { alreadyVerified: false, emailSent, emailConfigured: deps.mailer.configured };
}

/** Always answers the same way, so it cannot be used to discover which emails have accounts. */
export async function requestPasswordReset(deps: IdentityDeps, email: string) {
  const user = await deps.db.user.findUnique({ where: { email } });
  if (user && deps.mailer.configured) {
    const token = await issueEmailToken(deps, user.id, 'RESET_PASSWORD', RESET_TTL_MS);
    await sendSafely(deps, 'reset_password', () =>
      deps.mailer.send(resetPasswordMessage(user.email, `${deps.appOrigin}/reset-password?token=${token}`)),
    );
  }
  return { emailConfigured: deps.mailer.configured };
}

/** Sets the new password, signs out every session, and marks the email verified (the user proved inbox access). */
export async function resetPassword(
  deps: IdentityDeps,
  input: { token: string; password: string },
  meta: { requestId?: string; ip?: string } = {},
) {
  const row = await consumeEmailToken(deps, input.token, 'RESET_PASSWORD');
  const existing = await deps.db.user.findUniqueOrThrow({ where: { id: row.userId } });
  assertPasswordNotEmail(input.password, existing.email);
  const passwordHash = await hashPassword(input.password);
  await deps.db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: row.userId },
      data: { passwordHash, emailVerifiedAt: existing.emailVerifiedAt ?? new Date() },
    });
    await revokeOtherSessions(tx, row.userId);
    await writeAudit(tx, userActor(row.userId, meta), {
      action: 'user.password_reset',
      targetType: 'user',
      targetId: row.userId,
    });
  });
}

export async function changePassword(
  deps: IdentityDeps,
  actor: Actor,
  input: { currentPassword: string; newPassword: string; currentSessionId: string },
) {
  const user = await deps.db.user.findUniqueOrThrow({ where: { id: actor.userId } });
  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw new BadRequestError('WRONG_PASSWORD', 'Your current password is incorrect', {
      fields: { currentPassword: 'Incorrect password' },
    });
  }
  assertPasswordNotEmail(input.newPassword, user.email);
  const passwordHash = await hashPassword(input.newPassword);
  await deps.db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
    const revoked = await revokeOtherSessions(tx, user.id, input.currentSessionId);
    await writeAudit(tx, actor, {
      action: 'user.password_changed',
      targetType: 'user',
      targetId: user.id,
      metadata: { revokedSessions: revoked },
    });
  });
}

export async function updateProfile(deps: IdentityDeps, actor: Actor, input: { name: string }) {
  return deps.db.user.update({ where: { id: actor.userId }, data: { name: input.name } });
}

// ───────────────────────────── account deletion & export ─────────────────────────────

/**
 * Delete the account. Organizations where the user is the only member are deleted with it; if the user is the only
 * owner of an organization that has other members, ownership must be transferred first.
 */
export async function deleteAccount(deps: IdentityDeps, actor: Actor, password: string) {
  const user = await deps.db.user.findUniqueOrThrow({ where: { id: actor.userId } });
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new BadRequestError('WRONG_PASSWORD', 'Incorrect password', { fields: { password: 'Incorrect password' } });
  }
  await deps.db.$transaction(async (tx) => {
    const memberships = await tx.membership.findMany({ where: { userId: user.id }, include: { org: true } });
    for (const m of memberships) {
      const members = await tx.membership.findMany({ where: { orgId: m.orgId }, select: { userId: true, role: true } });
      if (members.length === 1) {
        await tx.organization.delete({ where: { id: m.orgId } });
        continue;
      }
      const otherOwners = members.filter((x) => x.role === 'OWNER' && x.userId !== user.id);
      if (m.role === 'OWNER' && otherOwners.length === 0) {
        throw new InvalidStateError(`Transfer ownership of "${m.org.name}" before deleting your account`, {
          orgId: m.orgId,
        });
      }
    }
    await writeAudit(tx, actor, { action: 'user.deleted', targetType: 'user', targetId: user.id });
    await tx.user.delete({ where: { id: user.id } });
  });
}

/** Everything stored about the user, for download (data portability). */
export async function exportAccount(deps: IdentityDeps, userId: string) {
  const user = await deps.db.user.findUniqueOrThrow({ where: { id: userId } });
  const [memberships, sessions, activity] = await Promise.all([
    deps.db.membership.findMany({
      where: { userId },
      select: { role: true, createdAt: true, org: { select: { id: true, name: true, slug: true } } },
    }),
    deps.db.session.findMany({
      where: { userId },
      select: { createdAt: true, lastSeenAt: true, expiresAt: true, revokedAt: true, userAgent: true, ip: true },
      orderBy: { createdAt: 'desc' },
    }),
    deps.db.auditLog.findMany({
      where: { actor: `user:${userId}` },
      select: { action: true, createdAt: true, targetType: true, targetId: true, ip: true },
      orderBy: { createdAt: 'desc' },
      take: 1_000,
    }),
  ]);
  return { exportedAt: new Date().toISOString(), user: publicUser(user), memberships, sessions, activity };
}
