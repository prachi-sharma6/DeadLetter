import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDb } from '@deadletter/db';
import { closeRedis, createLogger, createRedis, waitForRedis } from '@deadletter/runtime';
import { startWorker, type RunningWorker } from '@deadletter/worker';
import { createApp } from '../src/app';
import { loadApiConfig } from '../src/config';

// Single-service mode (RUN_WORKER=true): the worker runs inside the API process and is visible through /api/health.
const config = loadApiConfig({ ...process.env, LOG_LEVEL: 'silent', RUN_WORKER: 'true' });
const logger = createLogger({ service: 'combined-test', level: 'silent' });
const db = createDb({ url: config.DATABASE_URL, poolMax: 2 });
const redis = createRedis({ url: config.REDIS_URL, name: 'combined-test', logger, role: 'request' });
const app = createApp({ config, logger, db, redis });
let worker: RunningWorker;

beforeAll(async () => {
  await waitForRedis(redis);
  worker = await startWorker({ db, redisUrl: config.REDIS_URL, logger, version: 'test' });
});

afterAll(async () => {
  await closeRedis(redis);
  await db.$disconnect();
});

describe('API with an in-process worker', () => {
  it('reports the in-process worker as alive', async () => {
    await expect
      .poll(async () => (await request(app).get('/api/health')).body.workers as number, { timeout: 3_000 })
      .toBeGreaterThanOrEqual(1);
  });

  it('deregisters the worker on stop while the API keeps serving', async () => {
    await worker.stop();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.checks.database.ok).toBe(true);
    expect(await redis.zscore('dl:workers', worker.workerId)).toBeNull();
  });
});
