import type { Db, Project } from '@deadletter/db';
import { PLAN_LIMITS } from '@deadletter/shared';
import { writeAudit, type Actor } from '../audit';
import { BadRequestError, QuotaExceededError } from '../errors';
import type { OrgAccess, ProjectAccess } from './orgs';
import { makeSlug } from './slug';

/** Never exposes the encrypted webhook secret. */
export const publicProject = (p: Project) => ({
  id: p.id,
  orgId: p.orgId,
  name: p.name,
  slug: p.slug,
  description: p.description,
  recoveryMode: p.recoveryMode,
  webhookUrl: p.webhookUrl,
  webhookSecretSet: p.webhookSecretEnc !== null,
  redactKeys: p.redactKeys,
  replayCompletedAllowed: p.replayCompletedAllowed,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

export async function listProjects(db: Db, orgId: string) {
  const rows = await db.project.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
  return rows.map(publicProject);
}

export async function createProject(
  db: Db,
  actor: Actor,
  access: OrgAccess,
  input: { name: string; description: string },
) {
  const limit = PLAN_LIMITS[access.org.plan].projectsPerOrg;
  if ((await db.project.count({ where: { orgId: access.org.id } })) >= limit) {
    throw new QuotaExceededError(`Your plan allows ${limit} projects per organization`);
  }
  const project = await db.project.create({
    data: {
      orgId: access.org.id,
      name: input.name,
      description: input.description,
      slug: makeSlug(input.name),
      queues: { create: { name: 'default' } },
    },
  });
  await writeAudit(db, actor, {
    action: 'project.created',
    orgId: access.org.id,
    projectId: project.id,
    targetType: 'project',
    targetId: project.id,
    metadata: { name: project.name },
  });
  return project;
}

export async function updateProject(
  db: Db,
  actor: Actor,
  access: ProjectAccess,
  input: { name?: string; description?: string; redactKeys?: string[]; replayCompletedAllowed?: boolean },
) {
  const project = await db.project.update({ where: { id: access.project.id }, data: input });
  await writeAudit(db, actor, {
    action: 'project.updated',
    orgId: access.org.id,
    projectId: project.id,
    targetType: 'project',
    targetId: project.id,
    metadata: { fields: Object.keys(input) },
  });
  return project;
}

export async function deleteProject(db: Db, actor: Actor, access: ProjectAccess, confirmName: string) {
  if (confirmName !== access.project.name) {
    throw new BadRequestError('CONFIRMATION_MISMATCH', 'Type the project name exactly to confirm');
  }
  await writeAudit(db, actor, {
    action: 'project.deleted',
    orgId: access.org.id,
    targetType: 'project',
    targetId: access.project.id,
    metadata: { name: access.project.name },
  });
  await db.project.delete({ where: { id: access.project.id } });
}
