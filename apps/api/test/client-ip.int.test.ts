import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DisabledMailer } from '@deadletter/core';
import { createDb } from '@deadletter/db';
import { createLogger, createRedis, waitForRedis } from '@deadletter/runtime';
import { createApp } from '../src/app';
import { loadApiConfig } from '../src/config';
import { ORIGIN, PASSWORD, uniqueEmail } from './harness';

/**
 * Client-IP detection. The chains below are the real X-Forwarded-For values measured on Render on 2026-11-21:
 * client → Cloudflare edge (public 172.69.x.x) → Render proxy (10.x) → app. In tests the socket peer is loopback.
 * The derived IP is what sessions, audit rows and rate limits use.
 */
const logger = createLogger({ service: 'ip-test', level: 'silent' });
const base = loadApiConfig({ ...process.env, LOG_LEVEL: 'silent', APP_ORIGIN: ORIGIN, RATE_LIMITS: 'off' });
const db = createDb({ url: base.DATABASE_URL, poolMax: 2 });
const redis = createRedis({ url: base.REDIS_URL, name: 'ip-test', logger, role: 'request' });
const appWith = (TRUST_PROXY: 'cloudflare' | 'private') =>
  createApp({
    config: { ...base, TRUST_PROXY },
    logger,
    db,
    redis,
    identity: { db, mailer: new DisabledMailer(), appOrigin: ORIGIN },
  });
const cloudflareApp = appWith('cloudflare');

beforeAll(() => waitForRedis(redis));
afterAll(async () => {
  redis.disconnect();
  await db.$disconnect();
});

/** Sign up through a given X-Forwarded-For chain and return the IP recorded on the new session. */
async function sessionIpFor(app: ReturnType<typeof appWith>, xff?: string) {
  const email = uniqueEmail('ip');
  const r = request(app).post('/api/auth/signup').set('origin', ORIGIN);
  await (xff ? r.set('x-forwarded-for', xff) : r).send({ name: 'Ip', email, password: PASSWORD });
  return (await db.session.findFirstOrThrow({ where: { user: { email } } })).ip;
}

describe('client IP on Render (TRUST_PROXY=cloudflare)', () => {
  it('finds the real client behind Cloudflare and Render', async () => {
    expect(await sessionIpFor(cloudflareApp, '103.187.160.186, 172.69.178.230, 10.25.107.176')).toBe('103.187.160.186');
  });

  it('cannot be spoofed with a forged X-Forwarded-For (measured chain)', async () => {
    expect(await sessionIpFor(cloudflareApp, '1.2.3.4,103.187.160.186, 172.69.86.166, 10.28.5.144')).toBe(
      '103.187.160.186',
    );
  });

  it('handles IPv6 Cloudflare edges', async () => {
    expect(await sessionIpFor(cloudflareApp, '2001:db8::1, 2606:4700:10::1, 10.1.1.1')).toBe('2001:db8::1');
  });

  it('falls back to the socket address without a forwarding header', async () => {
    expect(await sessionIpFor(cloudflareApp)).toMatch(/127\.0\.0\.1|::1/);
  });
});

describe('TRUST_PROXY=private', () => {
  it('would wrongly pick the Cloudflare edge on Render (why the cloudflare mode exists)', async () => {
    expect(await sessionIpFor(appWith('private'), '103.187.160.186, 172.69.178.230, 10.25.107.176')).toBe(
      '172.69.178.230',
    );
  });
});
