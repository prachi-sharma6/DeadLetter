import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startWorker, type RunningWorker } from '@deadletter/worker';
import { createTestApp, type TestApp } from './harness';

// Single-service mode (RUN_WORKER=true): the worker runs inside the API process and is visible through /api/health.
let t: TestApp;
let worker: RunningWorker;

beforeAll(async () => {
  t = await createTestApp();
  worker = await startWorker({ db: t.db, redisUrl: t.config.REDIS_URL, logger: t.logger, version: 'test' });
});
afterAll(() => t.close());

describe('API with an in-process worker', () => {
  it('reports the in-process worker as alive', async () => {
    await expect
      .poll(async () => (await request(t.app).get('/api/health')).body.workers as number, { timeout: 3_000 })
      .toBeGreaterThanOrEqual(1);
  });

  it('deregisters the worker on stop while the API keeps serving', async () => {
    await worker.stop();
    const res = await request(t.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.checks.database.ok).toBe(true);
    expect(await t.redis.zscore('dl:workers', worker.workerId)).toBeNull();
  });
});
