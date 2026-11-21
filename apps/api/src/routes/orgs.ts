import { z } from 'zod';
import {
  acceptInvite,
  changeRole,
  createInvite,
  createOrg,
  createProject,
  deleteOrg,
  listInvites,
  listMembers,
  listMyOrgs,
  listProjects,
  publicProject,
  removeMember,
  revokeInvite,
  transferOwnership,
  updateOrg,
} from '@deadletter/core';
import {
  changeRoleSchema,
  confirmNameSchema,
  createOrgSchema,
  createProjectSchema,
  inviteSchema,
  tokenSchema,
  transferOwnershipSchema,
  updateOrgSchema,
} from '@deadletter/shared';
import { requireAuth, requireOrg } from '../http/context';
import { RULES } from '../http/rate-limit';
import { ok, parse, route } from '../http/registry';

const orgView = (o: { id: string; name: string; slug: string; plan: string; createdAt: Date }, role: string) => ({
  id: o.id,
  name: o.name,
  slug: o.slug,
  plan: o.plan,
  role,
  createdAt: o.createdAt,
});

const auditQuery = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().max(60).optional(),
});

export const orgRoutes = [
  route({
    method: 'get',
    path: '/orgs',
    scope: 'user',
    summary: 'Organizations the signed-in user belongs to',
    handler: async (req, _res, deps) => listMyOrgs(deps.db, requireAuth(req).user.id),
  }),
  route({
    method: 'post',
    path: '/orgs',
    scope: 'user',
    summary: 'Create an organization (you become its owner)',
    handler: async (req, res, deps) => {
      const org = await createOrg(deps.db, requireAuth(req).actor, parse(createOrgSchema, req.body));
      return ok(res, orgView(org, 'OWNER'), 201);
    },
  }),
  route({
    method: 'get',
    path: '/orgs/:orgId',
    scope: 'org',
    role: 'VIEWER',
    summary: 'Organization details and your role',
    handler: (req) => {
      const a = requireOrg(req);
      return orgView(a.org, a.role);
    },
  }),
  route({
    method: 'patch',
    path: '/orgs/:orgId',
    scope: 'org',
    role: 'ADMIN',
    summary: 'Rename the organization',
    handler: async (req, _res, deps) => {
      const a = requireOrg(req);
      return orgView(await updateOrg(deps.db, requireAuth(req).actor, a, parse(updateOrgSchema, req.body)), a.role);
    },
  }),
  route({
    method: 'delete',
    path: '/orgs/:orgId',
    scope: 'org',
    role: 'OWNER',
    summary: 'Delete the organization and everything in it (type its name to confirm)',
    handler: async (req, _res, deps) => {
      await deleteOrg(deps.db, requireAuth(req).actor, requireOrg(req), parse(confirmNameSchema, req.body).confirmName);
      return { deleted: true };
    },
  }),
  route({
    method: 'get',
    path: '/orgs/:orgId/members',
    scope: 'org',
    role: 'VIEWER',
    summary: 'Members and their roles',
    handler: async (req, _res, deps) => listMembers(deps.db, requireOrg(req).org.id),
  }),
  route({
    method: 'patch',
    path: '/orgs/:orgId/members/:membershipId',
    scope: 'org',
    role: 'ADMIN',
    summary: "Change a member's role",
    handler: async (req, _res, deps) => {
      const { role } = parse(changeRoleSchema, req.body);
      const m = await changeRole(
        deps.db,
        requireAuth(req).actor,
        requireOrg(req),
        String(req.params.membershipId),
        role,
      );
      return { membershipId: m.id, role: m.role };
    },
  }),
  route({
    method: 'delete',
    path: '/orgs/:orgId/members/:membershipId',
    scope: 'org',
    // Any member may remove themselves (leave); removing others is checked in the service (ADMIN, owner rules).
    role: 'VIEWER',
    summary: 'Remove a member, or leave the organization',
    handler: async (req, _res, deps) => {
      await removeMember(deps.db, requireAuth(req).actor, requireOrg(req), String(req.params.membershipId));
      return { removed: true };
    },
  }),
  route({
    method: 'post',
    path: '/orgs/:orgId/transfer-ownership',
    scope: 'org',
    role: 'OWNER',
    summary: 'Make another member the owner (you become an admin)',
    handler: async (req, _res, deps) => {
      const { membershipId } = parse(transferOwnershipSchema, req.body);
      await transferOwnership(deps.db, requireAuth(req).actor, requireOrg(req), membershipId);
      return { transferred: true };
    },
  }),
  route({
    method: 'get',
    path: '/orgs/:orgId/invites',
    scope: 'org',
    role: 'ADMIN',
    summary: 'Pending invitations',
    handler: async (req, _res, deps) => listInvites(deps.identity, requireOrg(req).org.id),
  }),
  route({
    method: 'post',
    path: '/orgs/:orgId/invites',
    scope: 'org',
    role: 'ADMIN',
    verified: true,
    summary: 'Invite someone by email',
    limits: [(req) => (req.auth ? [RULES.inviteUser, req.auth.user.id] : null)],
    handler: async (req, res, deps) => {
      const r = await createInvite(
        deps.identity,
        requireAuth(req).actor,
        requireOrg(req),
        parse(inviteSchema, req.body),
      );
      return ok(res, r, 201);
    },
  }),
  route({
    method: 'delete',
    path: '/orgs/:orgId/invites/:inviteId',
    scope: 'org',
    role: 'ADMIN',
    summary: 'Revoke an invitation',
    handler: async (req, _res, deps) => {
      await revokeInvite(deps.identity, requireAuth(req).actor, requireOrg(req), String(req.params.inviteId));
      return { revoked: true };
    },
  }),
  route({
    method: 'post',
    path: '/invites/accept',
    scope: 'user',
    summary: 'Accept an invitation sent to your email',
    limits: [(req) => [RULES.tokenIp, req.ip ?? '']],
    handler: async (req, _res, deps) => {
      const { user, actor } = requireAuth(req);
      return acceptInvite(deps.identity, actor, user, parse(tokenSchema, req.body).token);
    },
  }),
  route({
    method: 'get',
    path: '/orgs/:orgId/projects',
    scope: 'org',
    role: 'VIEWER',
    summary: 'Projects in the organization',
    handler: async (req, _res, deps) => listProjects(deps.db, requireOrg(req).org.id),
  }),
  route({
    method: 'post',
    path: '/orgs/:orgId/projects',
    scope: 'org',
    role: 'ADMIN',
    summary: 'Create a project',
    handler: async (req, res, deps) => {
      const p = await createProject(
        deps.db,
        requireAuth(req).actor,
        requireOrg(req),
        parse(createProjectSchema, req.body),
      );
      return ok(res, publicProject(p), 201);
    },
  }),
  route({
    method: 'get',
    path: '/orgs/:orgId/audit',
    scope: 'org',
    role: 'ADMIN',
    summary: 'Audit log of the organization (newest first, cursor pagination)',
    handler: async (req, _res, deps) => {
      const q = parse(auditQuery, req.query);
      const rows = await deps.db.auditLog.findMany({
        where: { orgId: requireOrg(req).org.id, ...(q.action ? { action: { startsWith: q.action } } : {}) },
        orderBy: { id: 'desc' },
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          actor: true,
          action: true,
          targetType: true,
          targetId: true,
          result: true,
          metadata: true,
          ip: true,
          createdAt: true,
        },
      });
      const page = rows.slice(0, q.limit);
      return { items: page, nextCursor: rows.length > q.limit ? page[page.length - 1]?.id : null };
    },
  }),
];
