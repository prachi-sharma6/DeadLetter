import request from 'supertest';
import { createDb } from '@deadletter/db';
import { truncateAllTables } from '@deadletter/db/testing';
import { DisabledMailer, MemoryMailer, type Mailer } from '@deadletter/core';
import { closeRedis, createLogger, createRedis, waitForRedis } from '@deadletter/runtime';
import { createApp } from '../src/app';
import { loadApiConfig } from '../src/config';

export const ORIGIN = 'http://localhost:5173';
export const PASSWORD = 'correct horse battery staple';

let n = 0;
export const uniqueEmail = (tag = 'user') => `${tag}-${Date.now().toString(36)}-${(n++).toString(36)}@example.test`;

/**
 * The real app wired to the test database and Redis. Email goes to an in-memory mailer (or is disabled) so tests can
 * follow verification and invitation links.
 */
export async function createTestApp(opts: { rateLimits?: 'on' | 'off'; email?: 'memory' | 'disabled' } = {}) {
  const config = loadApiConfig({
    ...process.env,
    LOG_LEVEL: 'silent',
    APP_ORIGIN: ORIGIN,
    RATE_LIMITS: opts.rateLimits ?? 'off',
  });
  const logger = createLogger({ service: 'api-test', level: 'silent' });
  const db = createDb({ url: config.DATABASE_URL, poolMax: 5 });
  const redis = createRedis({ url: config.REDIS_URL, name: 'api-test', logger, role: 'request' });
  await waitForRedis(redis);
  const mailer: Mailer = opts.email === 'disabled' ? new DisabledMailer() : new MemoryMailer();
  const app = createApp({ config, logger, db, redis, identity: { db, mailer, appOrigin: ORIGIN } });
  return {
    app,
    db,
    redis,
    config,
    logger,
    mailer,
    /** A cookie-keeping client that sends our Origin like a browser on the real site does. */
    client: () => request.agent(app).set('origin', ORIGIN),
    reset: () => truncateAllTables(db),
    close: async () => {
      await closeRedis(redis);
      await db.$disconnect();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Sign up a fresh user; returns the signed-in client, the user and their personal organization id. */
export async function signedUpUser(t: TestApp, name = 'Tester') {
  const client = t.client();
  const email = uniqueEmail(name.toLowerCase().replace(/\W/g, ''));
  const res = await client.post('/api/auth/signup').send({ name, email, password: PASSWORD });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  const me = await client.get('/api/auth/me');
  return {
    client,
    email,
    user: res.body.data.user as { id: string; email: string },
    orgId: me.body.data.orgs[0].id as string,
  };
}

/** Follow the verification link from the last email sent to `email`. */
export async function verify(t: TestApp, email: string) {
  const link = (t.mailer as MemoryMailer).lastLinkTo(email);
  if (!link) throw new Error(`no email with a link sent to ${email}`);
  const token = new URL(link).searchParams.get('token');
  const res = await request(t.app).post('/api/auth/verify-email').set('origin', ORIGIN).send({ token });
  if (res.status !== 200) throw new Error(`verify failed: ${res.status}`);
}
