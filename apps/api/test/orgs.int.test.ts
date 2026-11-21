import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticateApiKey, type MemoryMailer } from '@deadletter/core';
import { PLAN_LIMITS } from '@deadletter/shared';
import { createTestApp, signedUpUser, verify, type TestApp } from './harness';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  await t.reset();
});
afterAll(() => t.close());

const tokenFrom = (link: string | undefined) => new URL(link!).searchParams.get('token')!;

async function verifiedUser(name: string) {
  const u = await signedUpUser(t, name);
  await verify(t, u.email);
  return u;
}

async function addMember(orgId: string, role: 'ADMIN' | 'MEMBER' | 'VIEWER', name: string) {
  const u = await verifiedUser(name);
  const m = await t.db.membership.create({ data: { orgId, userId: u.user.id, role } });
  return { ...u, membershipId: m.id };
}

describe('invitations', () => {
  it('invites by email; the invited, verified user joins with the given role', async () => {
    const owner = await verifiedUser('Owner');
    const invitee = await verifiedUser('Invitee');
    const res = await owner.client
      .post(`/api/orgs/${owner.orgId}/invites`)
      .send({ email: invitee.email, role: 'ADMIN' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ emailSent: true, invite: { email: invitee.email, role: 'ADMIN' } });
    expect(res.body.data.inviteUrl).toBeUndefined(); // link only travels by email when email works

    const token = tokenFrom((t.mailer as MemoryMailer).lastLinkTo(invitee.email));
    const accepted = await invitee.client.post('/api/invites/accept').send({ token });
    expect(accepted.body.data).toMatchObject({ orgId: owner.orgId, role: 'ADMIN' });
    expect((await invitee.client.post('/api/invites/accept').send({ token })).body.error.code).toBe('INVALID_TOKEN');
    const members = await owner.client.get(`/api/orgs/${owner.orgId}/members`);
    expect(members.body.data.map((m: { role: string }) => m.role).sort()).toEqual(['ADMIN', 'OWNER']);
  });

  it('cannot be used by a different account, and requires a verified email', async () => {
    const owner = await verifiedUser('Owner2');
    const intended = await signedUpUser(t, 'Intended'); // not verified yet
    const verifyToken = tokenFrom((t.mailer as MemoryMailer).lastLinkTo(intended.email));
    const thief = await verifiedUser('Thief');
    await owner.client.post(`/api/orgs/${owner.orgId}/invites`).send({ email: intended.email });
    const token = tokenFrom((t.mailer as MemoryMailer).lastLinkTo(intended.email));
    expect((await thief.client.post('/api/invites/accept').send({ token })).status).toBe(403);
    expect((await intended.client.post('/api/invites/accept').send({ token })).body.error.code).toBe(
      'EMAIL_NOT_VERIFIED',
    );
    expect((await t.client().post('/api/auth/verify-email').send({ token: verifyToken })).status).toBe(200);
    expect((await intended.client.post('/api/invites/accept').send({ token })).status).toBe(200);
  });

  it('can be revoked, never grants ownership, and rejects people who are already members', async () => {
    const owner = await verifiedUser('Owner3');
    const target = await verifiedUser('Target');
    expect(
      (await owner.client.post(`/api/orgs/${owner.orgId}/invites`).send({ email: target.email, role: 'OWNER' })).status,
    ).toBe(400);
    const inv = (await owner.client.post(`/api/orgs/${owner.orgId}/invites`).send({ email: target.email })).body.data
      .invite;
    const token = tokenFrom((t.mailer as MemoryMailer).lastLinkTo(target.email));
    expect((await owner.client.delete(`/api/orgs/${owner.orgId}/invites/${inv.id}`)).status).toBe(200);
    expect((await target.client.post('/api/invites/accept').send({ token })).body.error.code).toBe('INVALID_TOKEN');
    expect(
      (await owner.client.post(`/api/orgs/${owner.orgId}/invites`).send({ email: owner.email })).body.error.code,
    ).toBe('ALREADY_MEMBER');
  });

  it('enforces the member limit including pending invitations', async () => {
    const owner = await verifiedUser('Owner4');
    const limit = PLAN_LIMITS.FREE.membersPerOrg;
    for (let i = 1; i < limit; i++) {
      expect(
        (
          await owner.client
            .post(`/api/orgs/${owner.orgId}/invites`)
            .send({ email: `p${i}-${owner.orgId}@example.test` })
        ).status,
      ).toBe(201);
    }
    const over = await owner.client
      .post(`/api/orgs/${owner.orgId}/invites`)
      .send({ email: `over-${owner.orgId}@example.test` });
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('QUOTA_EXCEEDED');
  });

  it('returns a shareable link when email delivery is not configured', async () => {
    const noMail = await createTestApp({ email: 'disabled' });
    try {
      const client = noMail.client();
      const email = `nomail-${Date.now()}@example.test`;
      await client.post('/api/auth/signup').send({ name: 'No Mail', email, password: 'correct horse battery staple' });
      const orgId = (await client.get('/api/auth/me')).body.data.orgs[0].id;
      const res = await client.post(`/api/orgs/${orgId}/invites`).send({ email: 'friend@example.test' });
      expect(res.status).toBe(201); // email verification is not required when email cannot be sent
      expect(res.body.data.emailSent).toBe(false);
      expect(res.body.data.inviteUrl).toMatch(/\/invite\?token=/);
    } finally {
      await noMail.close();
    }
  });
});

describe('roles and ownership', () => {
  it('admins manage members and viewers but not other admins or the owner', async () => {
    const owner = await verifiedUser('Boss');
    const admin = await addMember(owner.orgId, 'ADMIN', 'Admin');
    const admin2 = await addMember(owner.orgId, 'ADMIN', 'Admin2');
    const member = await addMember(owner.orgId, 'MEMBER', 'Member');
    const ownerMembership = await t.db.membership.findFirstOrThrow({ where: { orgId: owner.orgId, role: 'OWNER' } });

    expect(
      (await admin.client.patch(`/api/orgs/${owner.orgId}/members/${member.membershipId}`).send({ role: 'VIEWER' }))
        .status,
    ).toBe(200);
    expect(
      (await admin.client.patch(`/api/orgs/${owner.orgId}/members/${admin2.membershipId}`).send({ role: 'MEMBER' }))
        .status,
    ).toBe(403);
    expect(
      (await admin.client.patch(`/api/orgs/${owner.orgId}/members/${ownerMembership.id}`).send({ role: 'MEMBER' }))
        .status,
    ).toBe(403);
    expect(
      (await admin.client.patch(`/api/orgs/${owner.orgId}/members/${admin.membershipId}`).send({ role: 'MEMBER' }))
        .status,
    ).toBe(403);
    expect((await admin.client.delete(`/api/orgs/${owner.orgId}/members/${admin2.membershipId}`)).status).toBe(403);
    expect(
      (await owner.client.patch(`/api/orgs/${owner.orgId}/members/${admin2.membershipId}`).send({ role: 'MEMBER' }))
        .status,
    ).toBe(200);
  });

  it('members can leave; the owner can neither leave nor be removed until ownership is transferred', async () => {
    const owner = await verifiedUser('Founder');
    const member = await addMember(owner.orgId, 'MEMBER', 'Leaver');
    const heir = await addMember(owner.orgId, 'ADMIN', 'Heir');
    const ownerMembership = await t.db.membership.findFirstOrThrow({ where: { orgId: owner.orgId, role: 'OWNER' } });

    expect((await member.client.delete(`/api/orgs/${owner.orgId}/members/${member.membershipId}`)).status).toBe(200);
    expect((await owner.client.delete(`/api/orgs/${owner.orgId}/members/${ownerMembership.id}`)).status).toBe(409);
    expect((await heir.client.delete(`/api/orgs/${owner.orgId}/members/${ownerMembership.id}`)).status).toBe(409);

    expect(
      (await owner.client.post(`/api/orgs/${owner.orgId}/transfer-ownership`).send({ membershipId: heir.membershipId }))
        .status,
    ).toBe(200);
    const roles = await t.db.membership.findMany({
      where: { orgId: owner.orgId },
      select: { userId: true, role: true },
    });
    expect(roles.find((r) => r.userId === heir.user.id)?.role).toBe('OWNER');
    expect(roles.find((r) => r.userId === owner.user.id)?.role).toBe('ADMIN');
    expect((await owner.client.delete(`/api/orgs/${owner.orgId}/members/${ownerMembership.id}`)).status).toBe(200); // now allowed to leave
  });

  it('deleting an organization needs the owner and its exact name', async () => {
    const owner = await verifiedUser('Deleter');
    const admin = await addMember(owner.orgId, 'ADMIN', 'NotOwner');
    expect(
      (await admin.client.delete(`/api/orgs/${owner.orgId}`).send({ confirmName: "Deleter's workspace" })).status,
    ).toBe(403);
    expect((await owner.client.delete(`/api/orgs/${owner.orgId}`).send({ confirmName: 'wrong' })).body.error.code).toBe(
      'CONFIRMATION_MISMATCH',
    );
    expect(
      (await owner.client.delete(`/api/orgs/${owner.orgId}`).send({ confirmName: "Deleter's workspace" })).status,
    ).toBe(200);
    expect(await t.db.organization.findUnique({ where: { id: owner.orgId } })).toBeNull();
  });
});

describe('projects and API keys', () => {
  it('enforces the project limit per organization', async () => {
    const owner = await verifiedUser('Builder');
    for (let i = 0; i < PLAN_LIMITS.FREE.projectsPerOrg; i++) {
      expect((await owner.client.post(`/api/orgs/${owner.orgId}/projects`).send({ name: `Project ${i}` })).status).toBe(
        201,
      );
    }
    expect(
      (await owner.client.post(`/api/orgs/${owner.orgId}/projects`).send({ name: 'One too many' })).body.error.code,
    ).toBe('QUOTA_EXCEEDED');
  });

  it('shows an API key once, stores only a hash, and stops accepting it after revoke or rotate', async () => {
    const owner = await verifiedUser('KeyOwner');
    const project = (await owner.client.post(`/api/orgs/${owner.orgId}/projects`).send({ name: 'Keys' })).body.data;
    const created = await owner.client
      .post(`/api/projects/${project.id}/api-keys`)
      .send({ name: 'ci', scopes: ['jobs:write'] });
    expect(created.status).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    const { key, apiKey } = created.body.data;
    expect(key).toMatch(/^dl_live_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);

    const list = await owner.client.get(`/api/projects/${project.id}/api-keys`);
    expect(JSON.stringify(list.body)).not.toContain(key.slice(-20));
    const row = await t.db.apiKey.findUniqueOrThrow({ where: { id: apiKey.id } });
    expect(row.keyHash).not.toContain(key.slice(-20));

    const auth = await authenticateApiKey(t.db, key);
    expect(auth.project.id).toBe(project.id);
    await expect(authenticateApiKey(t.db, key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A'))).rejects.toThrow(
      'Invalid API key',
    );
    await expect(authenticateApiKey(t.db, 'garbage')).rejects.toThrow('Invalid API key');

    const rotated = await owner.client.post(`/api/projects/${project.id}/api-keys/${apiKey.id}/rotate`);
    await expect(authenticateApiKey(t.db, key)).rejects.toThrow(/revoked/);
    const newKey = rotated.body.data.key as string;
    expect((await authenticateApiKey(t.db, newKey)).key.scopes).toEqual(['jobs:write']);

    await owner.client.post(`/api/projects/${project.id}/api-keys/${rotated.body.data.apiKey.id}/revoke`);
    await expect(authenticateApiKey(t.db, newKey)).rejects.toThrow(/revoked/);
  });

  it('requires a verified email to create API keys (when email works)', async () => {
    const unverified = await signedUpUser(t, 'Unverified');
    const project = (await unverified.client.post(`/api/orgs/${unverified.orgId}/projects`).send({ name: 'Proj' })).body
      .data;
    const res = await unverified.client.post(`/api/projects/${project.id}/api-keys`).send({ name: 'k' });
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('records security-relevant actions in the audit log without secrets', async () => {
    const owner = await verifiedUser('Audited');
    const project = (await owner.client.post(`/api/orgs/${owner.orgId}/projects`).send({ name: 'Audit me' })).body.data;
    const { key } = (await owner.client.post(`/api/projects/${project.id}/api-keys`).send({ name: 'k' })).body.data;
    const log = await owner.client.get(`/api/orgs/${owner.orgId}/audit`);
    const actions = log.body.data.items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['user.signed_up', 'project.created', 'apikey.created']));
    expect(JSON.stringify(log.body)).not.toContain(key);
  });
});
