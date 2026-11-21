import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DisabledMailer } from '@deadletter/core';
import { createDb } from '@deadletter/db';
import { createLogger, createRedis, waitForRedis } from '@deadletter/runtime';
import { createApp } from '../src/app';
import { loadApiConfig } from '../src/config';
import { ORIGIN, PASSWORD, uniqueEmail } from './harness';

// Client-IP detection behind an internal proxy chain (the Render setup, TRUST_PROXY=private). The socket peer in tests
// is loopback, i.e. a trusted "proxy". The IP the app derives is what sessions, audit rows and rate limits use.
const config = loadApiConfig({
  ...process.env,
  LOG_LEVEL: 'silent',
  APP_ORIGIN: ORIGIN,
  TRUST_PROXY: 'private',
  RATE_LIMITS: 'off',
});
const logger = createLogger({ service: 'ip-test', level: 'silent' });
const db = createDb({ url: config.DATABASE_URL, poolMax: 2 });
const redis = createRedis({ url: config.REDIS_URL, name: 'ip-test', logger, role: 'request' });
const app = createApp({ config, logger, db, redis, identity: { db, mailer: new DisabledMailer(), appOrigin: ORIGIN } });

beforeAll(() => waitForRedis(redis));
afterAll(async () => {
  redis.disconnect();
  await db.$disconnect();
});

/** Sign up through a given X-Forwarded-For chain and return the IP recorded on the new session. */
async function sessionIpFor(xff?: string) {
  const email = uniqueEmail('ip');
  const r = request(app).post('/api/auth/signup').set('origin', ORIGIN);
  await (xff ? r.set('x-forwarded-for', xff) : r).send({ name: 'Ip', email, password: PASSWORD });
  const s = await db.session.findFirstOrThrow({ where: { user: { email } } });
  return s.ip;
}

describe('client IP behind private proxies', () => {
  it('takes the client address the platform appended before its internal hops', async () => {
    expect(await sessionIpFor('103.187.160.186, 10.28.192.255')).toBe('103.187.160.186');
    expect(await sessionIpFor('103.187.160.186, 10.1.2.3, 172.16.0.9')).toBe('103.187.160.186');
  });

  it('cannot be spoofed by a client sending its own X-Forwarded-For', async () => {
    // The attacker claims 1.2.3.4; the platform appends the real address after it.
    expect(await sessionIpFor('1.2.3.4, 203.0.113.50, 10.28.192.255')).toBe('203.0.113.50');
  });

  it('falls back to the socket address without a forwarding header', async () => {
    expect(await sessionIpFor()).toMatch(/127\.0\.0\.1|::1/);
  });
});
