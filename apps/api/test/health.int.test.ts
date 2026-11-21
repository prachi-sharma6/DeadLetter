import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closeRedis, createRedis } from '@deadletter/runtime';
import { createApp } from '../src/app';
import { createTestApp, type TestApp } from './harness';

// Real Postgres and Redis (local services, or service containers in CI).
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe('health endpoints', () => {
  it('liveness answers without touching dependencies', async () => {
    const res = await request(t.app).get('/api/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('readiness reports database and redis as healthy', async () => {
    const res = await request(t.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.database.ok).toBe(true);
    expect(res.body.checks.redis.ok).toBe(true);
  });

  it('sets security headers and a request id', async () => {
    const res = await request(t.app).get('/api/health/live');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('echoes a well-formed incoming request id and ignores a malformed one', async () => {
    const good = await request(t.app).get('/api/health/live').set('x-request-id', 'trace-abc12345');
    expect(good.headers['x-request-id']).toBe('trace-abc12345');
    const bad = await request(t.app).get('/api/health/live').set('x-request-id', 'bad id!');
    expect(bad.headers['x-request-id']).not.toBe('bad id!');
  });

  it('returns a JSON 404 for unknown API routes and rejects bad JSON safely', async () => {
    const nf = await request(t.app).get('/api/nope');
    expect(nf.status).toBe(404);
    expect(nf.body.error).toMatchObject({ code: 'NOT_FOUND' });
    const bad = await request(t.app)
      .post('/api/auth/login')
      .set('origin', 'http://localhost:5173')
      .set('content-type', 'application/json')
      .send('{"x":');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
  });

  it('reports degraded (503) when Redis is unreachable instead of hanging', async () => {
    const deadRedis = createRedis({ url: 'redis://127.0.0.1:1', name: 'dead', logger: t.logger, role: 'request' });
    const degraded = createApp({
      config: t.config,
      logger: t.logger,
      db: t.db,
      redis: deadRedis,
      identity: { db: t.db, mailer: t.mailer, appOrigin: 'http://localhost:5173' },
    });
    const t0 = Date.now();
    const res = await request(degraded).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.checks.redis.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await closeRedis(deadRedis);
  });
});
