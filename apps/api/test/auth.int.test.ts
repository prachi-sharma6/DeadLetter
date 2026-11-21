import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { MemoryMailer } from '@deadletter/core';
import { ORIGIN, PASSWORD, createTestApp, signedUpUser, uniqueEmail, verify, type TestApp } from './harness';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  await t.reset();
});
afterAll(() => t.close());

const tokenFrom = (link: string | undefined) => new URL(link!).searchParams.get('token')!;

describe('sign up', () => {
  it('creates the account, an owned organization, a session cookie and sends a verification email', async () => {
    const client = t.client();
    const email = uniqueEmail('new');
    const res = await client
      .post('/api/auth/signup')
      .send({ name: 'Ada', email: email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ email, name: 'Ada', emailVerified: false });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
    expect(res.body.data.verificationEmailSent).toBe(true);

    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/dl_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await client.get('/api/auth/me');
    expect(me.body.data.orgs).toHaveLength(1);
    expect(me.body.data.orgs[0]).toMatchObject({ role: 'OWNER', name: "Ada's workspace" });

    const stored = await t.db.user.findUniqueOrThrow({ where: { email } });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect((t.mailer as MemoryMailer).lastLinkTo(email)).toContain('/verify-email?token=');
  });

  it('rejects duplicate emails (case-insensitively) and weak passwords with field errors', async () => {
    const { email } = await signedUpUser(t);
    const dup = await t
      .client()
      .post('/api/auth/signup')
      .send({ name: 'X', email: email.toUpperCase(), password: PASSWORD });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');

    const weak = await t.client().post('/api/auth/signup').send({ name: '', email: 'bad', password: 'short' });
    expect(weak.status).toBe(400);
    expect(Object.keys(weak.body.error.details.fields)).toEqual(expect.arrayContaining(['name', 'email', 'password']));

    const withEmail = await t
      .client()
      .post('/api/auth/signup')
      .send({ name: 'Y', email: 'grace.hopper@example.test', password: 'grace.hopper-is-great' });
    expect(withEmail.status).toBe(400);
    expect(withEmail.body.error.code).toBe('WEAK_PASSWORD');
  });
});

describe('sign in and sessions', () => {
  it('signs in, and gives the same answer for a wrong password and an unknown account', async () => {
    const { email } = await signedUpUser(t);
    const good = await t.client().post('/api/auth/login').send({ email, password: PASSWORD });
    expect(good.status).toBe(200);
    const wrong = await t.client().post('/api/auth/login').send({ email, password: 'wrong password here' });
    const unknown = await t
      .client()
      .post('/api/auth/login')
      .send({ email: uniqueEmail('nobody'), password: 'wrong password here' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    expect(await t.db.auditLog.count({ where: { action: 'user.login_failed' } })).toBeGreaterThanOrEqual(2);
  });

  it('logout revokes the session server-side (a copied cookie stops working)', async () => {
    const { client } = await signedUpUser(t);
    const sessions = await client.get('/api/auth/sessions');
    expect(sessions.body.data).toHaveLength(1);
    const before = await t.db.session.count({ where: { revokedAt: null } });
    await client.post('/api/auth/logout');
    expect(await t.db.session.count({ where: { revokedAt: null } })).toBe(before - 1);
    expect((await client.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects forged or garbage session cookies', async () => {
    const res = await request(t.app).get('/api/auth/me').set('cookie', 'dl_session=forged-token-value-1234567890');
    expect(res.status).toBe(401);
  });

  it("lists sessions, revokes another device, and blocks touching other users' sessions", async () => {
    const { client, email } = await signedUpUser(t);
    const laptop = t.client();
    await laptop.post('/api/auth/login').send({ email, password: PASSWORD });
    const list = await client.get('/api/auth/sessions');
    expect(list.body.data).toHaveLength(2);
    const other = list.body.data.find((s: { current: boolean }) => !s.current);
    expect((await client.delete(`/api/auth/sessions/${other.id}`)).status).toBe(200);
    expect((await laptop.get('/api/auth/me')).status).toBe(401);

    const stranger = await signedUpUser(t, 'Stranger');
    const mine = (await client.get('/api/auth/sessions')).body.data[0].id;
    expect((await stranger.client.delete(`/api/auth/sessions/${mine}`)).status).toBe(404);
    expect((await client.get('/api/auth/me')).status).toBe(200);
  });
});

describe('email verification and password reset', () => {
  it('verifies email with a single-use link', async () => {
    const { client, email } = await signedUpUser(t);
    const token = tokenFrom((t.mailer as MemoryMailer).lastLinkTo(email));
    const first = await t.client().post('/api/auth/verify-email').send({ token });
    expect(first.body.data.user.emailVerified).toBe(true);
    expect((await t.client().post('/api/auth/verify-email').send({ token })).body.error.code).toBe('INVALID_TOKEN');
    expect((await client.get('/api/auth/me')).body.data.user.emailVerified).toBe(true);
  });

  it('only the newest verification link works after a resend', async () => {
    const { client, email } = await signedUpUser(t);
    const old = tokenFrom((t.mailer as MemoryMailer).lastLinkTo(email));
    await client.post('/api/auth/resend-verification');
    expect((await t.client().post('/api/auth/verify-email').send({ token: old })).status).toBe(400);
    await verify(t, email);
  });

  it('resets a forgotten password, signs out every session, and never reveals whether an account exists', async () => {
    const { client, email } = await signedUpUser(t);
    const known = await t.client().post('/api/auth/forgot-password').send({ email });
    const unknown = await t
      .client()
      .post('/api/auth/forgot-password')
      .send({ email: uniqueEmail('ghost') });
    expect(known.status).toBe(200);
    expect(unknown.body).toEqual(known.body);

    const token = tokenFrom((t.mailer as MemoryMailer).lastLinkTo(email));
    const newPassword = 'a brand new passphrase';
    expect((await t.client().post('/api/auth/reset-password').send({ token, password: newPassword })).status).toBe(200);
    expect((await client.get('/api/auth/me')).status).toBe(401); // old session revoked
    expect((await t.client().post('/api/auth/reset-password').send({ token, password: newPassword })).status).toBe(400); // single use
    expect((await t.client().post('/api/auth/login').send({ email, password: PASSWORD })).status).toBe(401);
    expect((await t.client().post('/api/auth/login').send({ email, password: newPassword })).status).toBe(200);
  });

  it('rejects expired reset links', async () => {
    const { email } = await signedUpUser(t);
    await t.client().post('/api/auth/forgot-password').send({ email });
    const token = tokenFrom((t.mailer as MemoryMailer).lastLinkTo(email));
    await t.db.emailToken.updateMany({
      where: { purpose: 'RESET_PASSWORD', usedAt: null },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expect(
      (await t.client().post('/api/auth/reset-password').send({ token, password: 'another long passphrase' })).body
        .error.code,
    ).toBe('INVALID_TOKEN');
  });
});

describe('change password, export and deletion', () => {
  it('changes the password, keeps this session, signs out the others', async () => {
    const { client, email } = await signedUpUser(t);
    const phone = t.client();
    await phone.post('/api/auth/login').send({ email, password: PASSWORD });
    const wrong = await client
      .post('/api/auth/change-password')
      .send({ currentPassword: 'nope nope nope', newPassword: 'another long passphrase' });
    expect(wrong.body.error.code).toBe('WRONG_PASSWORD');
    expect(
      (
        await client
          .post('/api/auth/change-password')
          .send({ currentPassword: PASSWORD, newPassword: 'another long passphrase' })
      ).status,
    ).toBe(200);
    expect((await client.get('/api/auth/me')).status).toBe(200);
    expect((await phone.get('/api/auth/me')).status).toBe(401);
  });

  it('exports account data without secrets', async () => {
    const { client } = await signedUpUser(t);
    const res = await client.get('/api/auth/me/export');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body.data.memberships).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|tokenHash|argon2/);
  });

  it('deletes the account and its solo organization, but not while it is the sole owner of a shared org', async () => {
    const owner = await signedUpUser(t, 'Owner');
    const mate = await signedUpUser(t, 'Mate');
    await t.db.membership.create({ data: { orgId: owner.orgId, userId: mate.user.id, role: 'MEMBER' } });

    expect((await owner.client.delete('/api/auth/me').send({ password: 'wrong wrong wrong' })).body.error.code).toBe(
      'WRONG_PASSWORD',
    );
    const blocked = await owner.client.delete('/api/auth/me').send({ password: PASSWORD });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/Transfer ownership/);

    expect((await mate.client.delete('/api/auth/me').send({ password: PASSWORD })).status).toBe(200);
    expect(await t.db.user.findUnique({ where: { id: mate.user.id } })).toBeNull();
    expect(await t.db.organization.findUnique({ where: { id: mate.orgId } })).toBeNull(); // solo org deleted
    expect(await t.db.organization.findUnique({ where: { id: owner.orgId } })).not.toBeNull();
    expect((await mate.client.get('/api/auth/me')).status).toBe(401);
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests from another origin or without an origin', async () => {
    const { email } = await signedUpUser(t);
    const foreign = await request(t.app)
      .post('/api/auth/login')
      .set('origin', 'https://evil.example')
      .send({ email, password: PASSWORD });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('CSRF_REJECTED');
    const none = await request(t.app).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(none.status).toBe(403);
    const viaReferer = await request(t.app)
      .post('/api/auth/login')
      .set('referer', `${ORIGIN}/login`)
      .send({ email, password: PASSWORD });
    expect(viaReferer.status).toBe(200);
  });

  it('allows safe (GET) requests without an Origin header', async () => {
    expect((await request(t.app).get('/api/auth/me')).status).toBe(401); // auth error, not CSRF
  });
});

describe('rate limits', () => {
  it('limits password guessing per account and tells the client when to retry', async () => {
    const limited = await createTestApp({ rateLimits: 'on' });
    try {
      const email = uniqueEmail('target');
      // Counters from earlier runs (same local IP) live in the test Redis for up to an hour; start clean.
      const stale = await limited.redis.keys('dl:rl:*');
      if (stale.length) await limited.redis.del(...stale);
      const attempt = () =>
        request(limited.app)
          .post('/api/auth/login')
          .set('origin', ORIGIN)
          .send({ email, password: 'guess guess guess' });
      for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401); // allowed attempts, wrong password
      const res = await attempt();
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });
});
