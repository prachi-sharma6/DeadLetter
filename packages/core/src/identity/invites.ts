import { PLAN_LIMITS } from '@deadletter/shared';
import type { Invite, MemberRole, User } from '@deadletter/db';
import { writeAudit, type Actor } from '../audit';
import { inviteMessage } from '../email/templates';
import {
  BadRequestError,
  DomainError,
  EmailNotVerifiedError,
  ForbiddenError,
  NotFoundError,
  QuotaExceededError,
} from '../errors';
import { hashToken, newToken } from './crypto';
import type { OrgAccess } from './orgs';
import type { IdentityDeps } from './users';

const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

export const publicInvite = (i: Invite) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  expiresAt: i.expiresAt,
  createdAt: i.createdAt,
});

const pendingWhere = (orgId: string, now = new Date()) => ({
  orgId,
  acceptedAt: null,
  revokedAt: null,
  expiresAt: { gt: now },
});

export async function listInvites(deps: IdentityDeps, orgId: string) {
  const rows = await deps.db.invite.findMany({ where: pendingWhere(orgId), orderBy: { createdAt: 'desc' } });
  return rows.map(publicInvite);
}

/**
 * Invite someone by email. Re-inviting the same address replaces the previous invitation. When email delivery is not
 * configured (or fails), the response carries the invitation link so an admin can share it another way.
 */
export async function createInvite(
  deps: IdentityDeps,
  actor: Actor,
  access: OrgAccess,
  input: { email: string; role: Exclude<MemberRole, 'OWNER'> },
) {
  const { db } = deps;
  const alreadyMember = await db.membership.findFirst({
    where: { orgId: access.org.id, user: { email: input.email } },
  });
  if (alreadyMember) throw new DomainError('ALREADY_MEMBER', 409, 'This person is already a member');

  const limit = PLAN_LIMITS[access.org.plan].membersPerOrg;
  const [members, pending] = await Promise.all([
    db.membership.count({ where: { orgId: access.org.id } }),
    db.invite.count({ where: { ...pendingWhere(access.org.id), NOT: { email: input.email } } }),
  ]);
  if (members + pending >= limit)
    throw new QuotaExceededError(`Your plan allows ${limit} members including pending invitations`);

  const token = newToken();
  const invite = await db.$transaction(async (tx) => {
    await tx.invite.updateMany({
      where: { ...pendingWhere(access.org.id), email: input.email },
      data: { revokedAt: new Date() },
    });
    const created = await tx.invite.create({
      data: {
        orgId: access.org.id,
        email: input.email,
        role: input.role,
        tokenHash: hashToken(token),
        invitedById: actor.userId,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    await writeAudit(tx, actor, {
      action: 'invite.created',
      orgId: access.org.id,
      targetType: 'invite',
      targetId: created.id,
      metadata: { email: input.email, role: input.role },
    });
    return created;
  });

  const inviteUrl = `${deps.appOrigin}/invite?token=${token}`;
  let emailSent = false;
  if (deps.mailer.configured) {
    const inviter = await db.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { name: true } });
    try {
      await deps.mailer.send(inviteMessage(input.email, access.org.name, inviter.name, inviteUrl));
      emailSent = true;
    } catch (err) {
      deps.onEmailError?.(err, 'invite');
    }
  }
  return { invite: publicInvite(invite), emailSent, inviteUrl: emailSent ? undefined : inviteUrl };
}

export async function revokeInvite(deps: IdentityDeps, actor: Actor, access: OrgAccess, inviteId: string) {
  const r = await deps.db.invite.updateMany({
    where: { id: inviteId, orgId: access.org.id, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (r.count === 0) throw new NotFoundError('Invitation');
  await writeAudit(deps.db, actor, {
    action: 'invite.revoked',
    orgId: access.org.id,
    targetType: 'invite',
    targetId: inviteId,
  });
}

/**
 * Accept an invitation. The token must be valid and the signed-in account's email must match the invited address
 * (verified, when email delivery is configured), so a forwarded link cannot be used by someone else's account.
 */
export async function acceptInvite(deps: IdentityDeps, actor: Actor, user: User, token: string) {
  const { db } = deps;
  const invite = await db.invite.findUnique({ where: { tokenHash: hashToken(token) }, include: { org: true } });
  const now = new Date();
  if (!invite || invite.revokedAt || invite.acceptedAt || invite.expiresAt <= now) {
    throw new BadRequestError('INVALID_TOKEN', 'This invitation is invalid or has expired');
  }
  if (invite.email !== user.email) throw new ForbiddenError('This invitation was sent to a different email address');
  if (deps.mailer.configured && !user.emailVerifiedAt) throw new EmailNotVerifiedError();

  await db.$transaction(async (tx) => {
    const claimed = await tx.invite.updateMany({
      where: { id: invite.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: now },
    });
    if (claimed.count !== 1) throw new BadRequestError('INVALID_TOKEN', 'This invitation is invalid or has expired');
    await tx.membership.upsert({
      where: { orgId_userId: { orgId: invite.orgId, userId: user.id } },
      create: { orgId: invite.orgId, userId: user.id, role: invite.role },
      update: {},
    });
    await writeAudit(tx, actor, {
      action: 'invite.accepted',
      orgId: invite.orgId,
      targetType: 'invite',
      targetId: invite.id,
      metadata: { role: invite.role },
    });
  });
  return { orgId: invite.orgId, orgName: invite.org.name, role: invite.role };
}
