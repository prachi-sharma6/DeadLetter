import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  IdempotencyKeyReusedError,
  RequestInProgressError,
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  consumeDailyJobQuota,
  pruneExpiredIdempotencyRecords,
} from '../src';
import { createProject, resetDb, testDb } from './fixtures';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.$disconnect());

describe('idempotency keys', () => {
  it('runs a request once and replays the stored response afterwards', async () => {
    const { project } = await createProject(db);
    const first = await beginIdempotentRequest(db, { projectId: project.id, key: 'k1', requestHash: 'h' });
    expect(first.kind).toBe('new');
    if (first.kind !== 'new') return;
    await completeIdempotentRequest(db, first.recordId, 201, { id: 'job_1' });
    expect(await beginIdempotentRequest(db, { projectId: project.id, key: 'k1', requestHash: 'h' })).toEqual({
      kind: 'replay',
      statusCode: 201,
      response: { id: 'job_1' },
    });
  });

  it('rejects reuse of a key with a different request', async () => {
    const { project } = await createProject(db);
    await beginIdempotentRequest(db, { projectId: project.id, key: 'k', requestHash: 'h1' });
    await expect(
      beginIdempotentRequest(db, { projectId: project.id, key: 'k', requestHash: 'h2' }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it('lets exactly one of many concurrent identical requests through', async () => {
    const { project } = await createProject(db);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        beginIdempotentRequest(db, { projectId: project.id, key: 'race', requestHash: 'h' }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 'rejected').every((r) => r.reason instanceof RequestInProgressError),
    ).toBe(true);
  });

  it('scopes keys per project', async () => {
    const a = await createProject(db);
    const b = await createProject(db);
    expect((await beginIdempotentRequest(db, { projectId: a.project.id, key: 'same', requestHash: 'h' })).kind).toBe(
      'new',
    );
    expect((await beginIdempotentRequest(db, { projectId: b.project.id, key: 'same', requestHash: 'h' })).kind).toBe(
      'new',
    );
  });

  it('takes over a reservation abandoned by a crashed request', async () => {
    const { project } = await createProject(db);
    const t0 = new Date(Date.now() - 5 * 60_000);
    await beginIdempotentRequest(db, { projectId: project.id, key: 'stale', requestHash: 'h', now: t0 });
    expect((await beginIdempotentRequest(db, { projectId: project.id, key: 'stale', requestHash: 'h' })).kind).toBe(
      'new',
    );
  });

  it('frees the key after a server error, and expires old records', async () => {
    const { project } = await createProject(db);
    const r = await beginIdempotentRequest(db, { projectId: project.id, key: 'err', requestHash: 'h' });
    if (r.kind === 'new') await abandonIdempotentRequest(db, r.recordId);
    expect((await beginIdempotentRequest(db, { projectId: project.id, key: 'err', requestHash: 'h' })).kind).toBe(
      'new',
    );

    const old = await beginIdempotentRequest(db, {
      projectId: project.id,
      key: 'old',
      requestHash: 'h',
      ttlMs: 1,
      now: new Date(Date.now() - 10_000),
    });
    if (old.kind === 'new') await completeIdempotentRequest(db, old.recordId, 200, { x: 1 });
    // expired: the same key with a different request is now a fresh request, not a conflict
    expect((await beginIdempotentRequest(db, { projectId: project.id, key: 'old', requestHash: 'other' })).kind).toBe(
      'new',
    );
    expect(await pruneExpiredIdempotencyRecords(db, new Date(Date.now() + 48 * 3_600_000))).toBeGreaterThan(0);
  });
});

describe('daily job quota', () => {
  it('never lets concurrent requests exceed the limit', async () => {
    const { project } = await createProject(db);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => consumeDailyJobQuota(db, { projectId: project.id, amount: 1, limit: 10 })),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(Math.max(...results.map((r) => r.used))).toBe(10);
  });

  it('rejects a batch that would cross the limit without consuming anything', async () => {
    const { project } = await createProject(db);
    await consumeDailyJobQuota(db, { projectId: project.id, amount: 8, limit: 10 });
    expect(await consumeDailyJobQuota(db, { projectId: project.id, amount: 5, limit: 10 })).toEqual({
      allowed: false,
      used: 8,
      limit: 10,
    });
    expect(await consumeDailyJobQuota(db, { projectId: project.id, amount: 11, limit: 10 })).toMatchObject({
      allowed: false,
      used: 8,
    });
    expect(await consumeDailyJobQuota(db, { projectId: project.id, amount: 2, limit: 10 })).toEqual({
      allowed: true,
      used: 10,
      limit: 10,
    });
  });

  it('resets per UTC day and per project', async () => {
    const { project } = await createProject(db);
    const other = await createProject(db);
    const day1 = new Date('2026-11-20T23:59:00Z');
    const day2 = new Date('2026-11-21T00:01:00Z');
    expect((await consumeDailyJobQuota(db, { projectId: project.id, amount: 3, limit: 3, now: day1 })).allowed).toBe(
      true,
    );
    expect((await consumeDailyJobQuota(db, { projectId: project.id, amount: 1, limit: 3, now: day1 })).allowed).toBe(
      false,
    );
    expect((await consumeDailyJobQuota(db, { projectId: project.id, amount: 1, limit: 3, now: day2 })).allowed).toBe(
      true,
    );
    expect(
      (await consumeDailyJobQuota(db, { projectId: other.project.id, amount: 3, limit: 3, now: day1 })).allowed,
    ).toBe(true);
  });
});
