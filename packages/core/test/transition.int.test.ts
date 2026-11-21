import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ConcurrentUpdateError, InvalidStateError, NotFoundError, transitionJob } from '../src';
import { createJob, createProject, resetDb, testDb } from './fixtures';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.$disconnect());

describe('transitionJob', () => {
  it('moves a job, sets extra columns and bumps the version', async () => {
    const ctx = await createProject(db);
    const job = await createJob(db, ctx);
    const startedAt = new Date();
    const updated = await transitionJob(db, {
      jobId: job.id,
      to: 'PROCESSING',
      data: { lastStartedAt: startedAt, attemptCount: { increment: 1 } },
    });
    expect(updated).toMatchObject({ status: 'PROCESSING', version: 1, attemptCount: 1 });
    expect(updated.lastStartedAt?.getTime()).toBe(startedAt.getTime());
  });

  it('refuses a move the job is not in a state for (completed jobs stay completed)', async () => {
    const ctx = await createProject(db);
    const job = await createJob(db, ctx, { status: 'COMPLETED' });
    await expect(
      transitionJob(db, { jobId: job.id, to: 'RETRYING', from: ['FAILED', 'DEAD_LETTER'] }),
    ).rejects.toBeInstanceOf(InvalidStateError);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('COMPLETED');
  });

  it('throws on an illegal transition request before touching the database', async () => {
    const ctx = await createProject(db);
    const job = await createJob(db, ctx);
    await expect(transitionJob(db, { jobId: job.id, to: 'QUEUED', from: ['COMPLETED'] })).rejects.toThrow(
      /Invalid job status transition/,
    );
  });

  it('detects a stale version (someone else updated the job)', async () => {
    const ctx = await createProject(db);
    const job = await createJob(db, ctx);
    await transitionJob(db, { jobId: job.id, to: 'PROCESSING', expectedVersion: 0 });
    await db.job.update({ where: { id: job.id }, data: { version: { increment: 1 } } });
    await expect(
      transitionJob(db, { jobId: job.id, to: 'COMPLETED', from: ['PROCESSING'], expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(ConcurrentUpdateError);
  });

  it('reports a missing job', async () => {
    await expect(
      transitionJob(db, { jobId: '0190a5c0-0000-7000-8000-000000000000', to: 'PROCESSING' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lets exactly one of 20 concurrent workers start the same job', async () => {
    const ctx = await createProject(db);
    const job = await createJob(db, ctx);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        transitionJob(db, {
          jobId: job.id,
          to: 'PROCESSING',
          from: ['QUEUED'],
          data: { attemptCount: { increment: 1 } },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r) => r.reason instanceof InvalidStateError)).toBe(
      true,
    );
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: 'PROCESSING',
      attemptCount: 1,
      version: 1,
    });
  });
});
