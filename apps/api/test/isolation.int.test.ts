import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { RouteDef } from '../src/http/registry';
import { routes } from '../src/routes';
import { ORIGIN, createTestApp, signedUpUser, verify, type TestApp } from './harness';

/**
 * Tenant isolation, generated from the route registry: every org/project route added in the future is covered
 * automatically. Organization A is the victim; B is another customer; V is a viewer inside A.
 */
let t: TestApp;
type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;

async function setup(t: TestApp) {
  const a = await signedUpUser(t, 'Alice');
  await verify(t, a.email);
  const b = await signedUpUser(t, 'Bob');
  await verify(t, b.email);
  const v = await signedUpUser(t, 'Victor');

  const projA = (await a.client.post(`/api/orgs/${a.orgId}/projects`).send({ name: 'Victim project' })).body.data;
  const keyA = (await a.client.post(`/api/projects/${projA.id}/api-keys`).send({ name: 'victim key' })).body.data;
  const inviteA = (
    await a.client.post(`/api/orgs/${a.orgId}/invites`).send({ email: 'someone@example.test', role: 'MEMBER' })
  ).body.data;
  const viewerMembership = await t.db.membership.create({
    data: { orgId: a.orgId, userId: v.user.id, role: 'VIEWER' },
  });

  const projB = (await b.client.post(`/api/orgs/${b.orgId}/projects`).send({ name: 'Attacker project' })).body.data;
  const membershipB = await t.db.membership.findFirstOrThrow({ where: { orgId: b.orgId } });

  return {
    a,
    b,
    v,
    victim: {
      orgId: a.orgId,
      projectId: projA.id,
      keyId: keyA.apiKey.id,
      inviteId: inviteA.invite.id,
      membershipId: viewerMembership.id,
    },
    attacker: { orgId: b.orgId, projectId: projB.id, membershipId: membershipB.id },
  };
}

beforeAll(async () => {
  t = await createTestApp();
  await t.reset();
  ctx = await setup(t);
});
afterAll(() => t.close());

const tenantRoutes = routes.filter((r) => r.scope === 'org' || r.scope === 'project');
const fill = (path: string, ids: Record<string, string>) =>
  path.replace(/:(\w+)/g, (_, k: string) => ids[k] ?? `missing-${k}`);
const label = (r: RouteDef) => `${r.method.toUpperCase()} ${r.path}`;
const call = (client: ReturnType<TestApp['client']>, r: RouteDef, path: string) =>
  client[r.method](`/api${path}`).send(
    r.method === 'get'
      ? undefined
      : { confirmName: 'x', name: 'pwned', role: 'ADMIN', email: 'x@example.test', token: 'x'.repeat(40) },
  );

describe('route registry', () => {
  it('declares org scope for every :orgId route and project scope for every :projectId route', () => {
    for (const r of routes) {
      if (r.path.includes(':orgId')) expect(r.scope, label(r)).toBe('org');
      if (r.path.includes(':projectId')) expect(r.scope, label(r)).toBe('project');
    }
    expect(tenantRoutes.length).toBeGreaterThan(15);
  });
});

describe('outsiders (another organization) get 404 on every tenant route', () => {
  it.each(tenantRoutes.map((r) => [label(r), r] as const))('%s', async (_name, r) => {
    const res = await call(ctx.b.client, r, fill(r.path, ctx.victim));
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('left the victim organization untouched', async () => {
    const org = await t.db.organization.findUniqueOrThrow({ where: { id: ctx.victim.orgId } });
    expect(org.name).toBe("Alice's workspace");
    expect(await t.db.project.findUnique({ where: { id: ctx.victim.projectId } })).not.toBeNull();
    expect((await t.db.apiKey.findUniqueOrThrow({ where: { id: ctx.victim.keyId } })).revokedAt).toBeNull();
    expect((await t.db.invite.findUniqueOrThrow({ where: { id: ctx.victim.inviteId } })).revokedAt).toBeNull();
    expect((await t.db.membership.findUniqueOrThrow({ where: { id: ctx.victim.membershipId } })).role).toBe('VIEWER');
  });
});

describe("an admin cannot reach another organization's objects through their own organization", () => {
  const withSecondaryId = tenantRoutes.filter((r) => /:(membershipId|inviteId|keyId)/.test(r.path));
  it.each(withSecondaryId.map((r) => [label(r), r] as const))('%s', async (_name, r) => {
    // Attacker's own org/project in the URL, the victim's member/invite/key id in the second slot.
    const ids = { ...ctx.victim, orgId: ctx.attacker.orgId, projectId: ctx.attacker.projectId };
    const res = await call(ctx.b.client, r, fill(r.path, ids));
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });
});

describe('viewers are refused every action above their role (403)', () => {
  const aboveViewer = tenantRoutes.filter((r) => r.role && r.role !== 'VIEWER');
  it.each(aboveViewer.map((r) => [label(r), r] as const))('%s', async (_name, r) => {
    const res = await call(ctx.v.client, r, fill(r.path, ctx.victim));
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('anonymous callers get 401 on every non-public route', () => {
  it.each(routes.filter((r) => r.scope !== 'public').map((r) => [label(r), r] as const))('%s', async (_name, r) => {
    const path = fill(r.path, { ...ctx.victim, sessionId: ctx.victim.membershipId });
    const res = await request(t.app)[r.method](`/api${path}`).set('origin', ORIGIN).send({});
    expect(res.status).toBe(401);
  });
});

describe('malformed ids', () => {
  it('are "not found", never a server error', async () => {
    const res = await ctx.a.client.get('/api/orgs/not-a-uuid/members');
    expect(res.status).toBe(404);
    const res2 = await ctx.a.client.post(`/api/projects/${ctx.victim.projectId}/api-keys/123/revoke`);
    expect(res2.status).toBe(404);
  });
});
