import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDb } from '@deadletter/db';
import { closeRedis, createLogger, createRedis, waitForRedis } from '@deadletter/runtime';
import { createApp } from '../src/app';
import { loadApiConfig } from '../src/config';

// Real Postgres and Redis (local services, or service containers in CI).
const config = loadApiConfig({ ...process.env, LOG_LEVEL: 'silent' });
const logger = createLogger({ service: 'api-test', level: 'silent' });
const db = createDb({ url: config.DATABASE_URL, poolMax: config.DATABASE_POOL_MAX });
const redis = createRedis({ url: config.REDIS_URL, name: 'api-test', logger, role: 'request' });
const app = createApp({ config, logger, db, redis });

beforeAll(() => waitForRedis(redis));
afterAll(async () => {
  await closeRedis(redis);
  await db.$disconnect();
});

describe('health endpoints', () => {
  it('liveness answers without touching dependencies', async () => {
    const res = await request(app).get('/api/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('readiness reports database and redis as healthy', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.database.ok).toBe(true);
    expect(res.body.checks.redis.ok).toBe(true);
  });

  it('sets security headers and a request id', async () => {
    const res = await request(app).get('/api/health/live');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('echoes a well-formed incoming request id and ignores a malformed one', async () => {
    expect(
      (await request(app).get('/api/health/live').set('x-request-id', 'trace-abc12345')).headers['x-request-id'],
    ).toBe('trace-abc12345');
    expect(
      (await request(app).get('/api/health/live').set('x-request-id', 'bad id!')).headers['x-request-id'],
    ).not.toBe('bad id!');
  });

  it('returns a JSON 404 for unknown API routes and rejects bad JSON safely', async () => {
    const nf = await request(app).get('/api/nope');
    expect(nf.status).toBe(404);
    expect(nf.body.error).toMatchObject({ code: 'NOT_FOUND' });
    const bad = await request(app).post('/api/nope').set('content-type', 'application/json').send('{"x":');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
  });

  it('reports degraded (503) when Redis is unreachable instead of hanging', async () => {
    const deadRedis = createRedis({ url: 'redis://127.0.0.1:1', name: 'dead', logger, role: 'request' });
    const degraded = createApp({ config, logger, db, redis: deadRedis });
    const t0 = Date.now();
    const res = await request(degraded).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.checks.redis.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5_000);
    deadRedis.disconnect();
  });
});
