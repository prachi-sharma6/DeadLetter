import type { Db, Membership, MemberRole, Organization, PrismaClient, Project } from '@deadletter/db';
import { hasRole } from '@deadletter/shared';
import { writeAudit, type Actor } from '../audit';
import { BadRequestError, ForbiddenError, InvalidStateError, NotFoundError, QuotaExceededError } from '../errors';
import { makeSlug } from './slug';

/** Organizations one user may create; keeps a single account from filling the free-tier database. */
export const MAX_ORGS_PER_USER = 5;

export interface OrgAccess {
  org: Organization;
  membership: Membership;
  role: MemberRole;
}

export interface ProjectAccess extends OrgAccess {
  project: Project;
}

/**
 * Membership check for an organization. Non-members get NotFoundError (the same answer as for an id that does not
 * exist, so ids cannot be probed); members below `minRole` get ForbiddenError.
 */
export async function requireOrgAccess(db: Db, orgId: string, userId: string, minRole: MemberRole): Promise<OrgAccess> {
  const membership = await db.membership.findUnique({
    where: { orgId_userId: { orgId, userId } },
    include: { org: true },
  });
  if (!membership) throw new NotFoundError('Organization');
  if (!hasRole(membership.role, minRole)) throw new ForbiddenError(`This action requires the ${minRole} role`);
  const { org, ...m } = membership;
  return { org, membership: m, role: m.role };
}

export async function requireProjectAccess(
  db: Db,
  projectId: string,
  userId: string,
  minRole: MemberRole,
): Promise<ProjectAccess> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) throw new NotFoundError('Project');
  try {
    return { ...(await requireOrgAccess(db, project.orgId, userId, minRole)), project };
  } catch (err) {
    if (err instanceof NotFoundError) throw new NotFoundError('Project');
    throw err;
  }
}

export async function listMyOrgs(db: Db, userId: string) {
  const rows = await db.membership.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    include: { org: { include: { _count: { select: { memberships: true, projects: true } } } } },
  });
  return rows.map((m) => ({
    id: m.org.id,
    name: m.org.name,
    slug: m.org.slug,
    plan: m.org.plan,
    role: m.role,
    members: m.org._count.memberships,
    projects: m.org._count.projects,
    createdAt: m.org.createdAt,
  }));
}

export async function createOrg(db: Db, actor: Actor, input: { name: string }) {
  const owned = await db.membership.count({ where: { userId: actor.userId, role: 'OWNER' } });
  if (owned >= MAX_ORGS_PER_USER)
    throw new QuotaExceededError(`You can own at most ${MAX_ORGS_PER_USER} organizations`);
  const org = await db.organization.create({
    data: {
      name: input.name,
      slug: makeSlug(input.name),
      memberships: { create: { userId: actor.userId, role: 'OWNER' } },
    },
  });
  await writeAudit(db, actor, {
    action: 'org.created',
    orgId: org.id,
    targetType: 'org',
    targetId: org.id,
    metadata: { name: org.name },
  });
  return org;
}

export async function updateOrg(db: Db, actor: Actor, access: OrgAccess, input: { name: string }) {
  const org = await db.organization.update({ where: { id: access.org.id }, data: { name: input.name } });
  await writeAudit(db, actor, {
    action: 'org.updated',
    orgId: org.id,
    targetType: 'org',
    targetId: org.id,
    metadata: { name: org.name },
  });
  return org;
}

/** Owner only, and the exact name must be typed to confirm. Cascades to projects, jobs and history. */
export async function deleteOrg(db: Db, actor: Actor, access: OrgAccess, confirmName: string) {
  if (confirmName !== access.org.name) {
    throw new BadRequestError('CONFIRMATION_MISMATCH', 'Type the organization name exactly to confirm');
  }
  await writeAudit(db, actor, {
    action: 'org.deleted',
    targetType: 'org',
    targetId: access.org.id,
    metadata: { name: access.org.name },
  });
  await db.organization.delete({ where: { id: access.org.id } });
}

export async function listMembers(db: Db, orgId: string) {
  const rows = await db.membership.findMany({
    where: { orgId },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  return rows.map((m) => ({ membershipId: m.id, role: m.role, joinedAt: m.createdAt, user: m.user }));
}

async function loadTarget(db: Db, access: OrgAccess, membershipId: string) {
  const target = await db.membership.findFirst({ where: { id: membershipId, orgId: access.org.id } });
  if (!target) throw new NotFoundError('Member');
  return target;
}

/** Admins manage members and viewers; only the owner manages admins. Ownership moves only by transfer. */
export async function changeRole(
  db: Db,
  actor: Actor,
  access: OrgAccess,
  membershipId: string,
  role: Exclude<MemberRole, 'OWNER'>,
) {
  const target = await loadTarget(db, access, membershipId);
  if (target.userId === actor.userId) throw new ForbiddenError('You cannot change your own role');
  if (target.role === 'OWNER') throw new ForbiddenError('Transfer ownership to change the owner');
  if (target.role === 'ADMIN' && access.role !== 'OWNER')
    throw new ForbiddenError('Only the owner can change an admin');
  const updated = await db.membership.update({ where: { id: target.id }, data: { role } });
  await writeAudit(db, actor, {
    action: 'member.role_changed',
    orgId: access.org.id,
    targetType: 'membership',
    targetId: target.id,
    metadata: { from: target.role, to: role, userId: target.userId },
  });
  return updated;
}

/** Remove someone (admins) or leave (anyone). The owner cannot be removed and cannot leave without a transfer. */
export async function removeMember(db: Db, actor: Actor, access: OrgAccess, membershipId: string) {
  const target = await loadTarget(db, access, membershipId);
  const self = target.userId === actor.userId;
  if (target.role === 'OWNER') {
    throw new InvalidStateError(self ? 'Transfer ownership before leaving' : 'The owner cannot be removed');
  }
  if (!self) {
    if (!hasRole(access.role, 'ADMIN')) throw new ForbiddenError('This action requires the ADMIN role');
    if (target.role === 'ADMIN' && access.role !== 'OWNER')
      throw new ForbiddenError('Only the owner can remove an admin');
  }
  await db.membership.delete({ where: { id: target.id } });
  await writeAudit(db, actor, {
    action: self ? 'member.left' : 'member.removed',
    orgId: access.org.id,
    targetType: 'membership',
    targetId: target.id,
    metadata: { userId: target.userId, role: target.role },
  });
}

/** The current owner hands ownership to another member and becomes an admin, atomically. */
export async function transferOwnership(db: PrismaClient, actor: Actor, access: OrgAccess, membershipId: string) {
  if (access.role !== 'OWNER') throw new ForbiddenError('Only the owner can transfer ownership');
  const target = await loadTarget(db, access, membershipId);
  if (target.userId === actor.userId) throw new BadRequestError('INVALID_TARGET', 'You already own this organization');
  await db.$transaction(async (tx) => {
    await tx.membership.update({ where: { id: target.id }, data: { role: 'OWNER' } });
    await tx.membership.update({ where: { id: access.membership.id }, data: { role: 'ADMIN' } });
    await writeAudit(tx, actor, {
      action: 'org.ownership_transferred',
      orgId: access.org.id,
      targetType: 'membership',
      targetId: target.id,
      metadata: { to: target.userId },
    });
  });
}
