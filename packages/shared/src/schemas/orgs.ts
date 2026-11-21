import { z } from 'zod';
import { emailSchema } from './auth';

export const MEMBER_ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Higher rank can do everything a lower rank can. */
export const ROLE_RANK: Readonly<Record<MemberRole, number>> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };
export const hasRole = (actual: MemberRole, required: MemberRole) => ROLE_RANK[actual] >= ROLE_RANK[required];

/** Roles an invite or role change may grant. Ownership only moves through an explicit transfer. */
export const ASSIGNABLE_ROLES = ['ADMIN', 'MEMBER', 'VIEWER'] as const;

export const orgNameSchema = z.string().trim().min(2, 'Use at least 2 characters').max(80);
export const createOrgSchema = z.object({ name: orgNameSchema });
export const updateOrgSchema = z.object({ name: orgNameSchema });
export const confirmNameSchema = z.object({ confirmName: z.string().min(1) });

export const inviteSchema = z.object({ email: emailSchema, role: z.enum(ASSIGNABLE_ROLES).default('MEMBER') });
export const changeRoleSchema = z.object({ role: z.enum(ASSIGNABLE_ROLES) });
export const transferOwnershipSchema = z.object({ membershipId: z.uuid() });

export const projectNameSchema = z.string().trim().min(2, 'Use at least 2 characters').max(80);
export const createProjectSchema = z.object({
  name: projectNameSchema,
  description: z.string().trim().max(500).default(''),
});
export const updateProjectSchema = z.object({
  name: projectNameSchema.optional(),
  description: z.string().trim().max(500).optional(),
  redactKeys: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  replayCompletedAllowed: z.boolean().optional(),
});

export const API_KEY_SCOPES = ['jobs:write', 'jobs:read', 'recover', 'analytics:read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(60),
  scopes: z
    .array(z.enum(API_KEY_SCOPES))
    .min(1, 'Choose at least one permission')
    .default([...API_KEY_SCOPES]),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});
