import { createDb, type PrismaClient } from '@deadletter/db';
import { truncateAllTables } from '@deadletter/db/testing';

let n = 0;
const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;

export function testDb(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (see .env.test)');
  return createDb({ url, poolMax: 10 });
}

export const resetDb = (db: PrismaClient) => truncateAllTables(db);

export async function createProject(db: PrismaClient) {
  const org = await db.organization.create({ data: { name: 'Org', slug: uniq('org') } });
  const project = await db.project.create({ data: { orgId: org.id, name: 'Project', slug: uniq('proj') } });
  const queue = await db.queue.create({ data: { projectId: project.id, name: 'default' } });
  return { org, project, queue };
}

export async function createJob(
  db: PrismaClient,
  ctx: { project: { id: string }; queue: { id: string } },
  overrides: Partial<{
    status: 'QUEUED' | 'PROCESSING' | 'FAILED' | 'COMPLETED' | 'DEAD_LETTER';
    maxAttempts: number;
  }> = {},
) {
  return db.job.create({
    data: {
      projectId: ctx.project.id,
      queueId: ctx.queue.id,
      externalId: uniq('job'),
      name: 'send-email',
      type: 'send-email',
      maxAttempts: overrides.maxAttempts ?? 3,
      status: overrides.status ?? 'QUEUED',
    },
  });
}
