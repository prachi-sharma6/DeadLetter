import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiKey, Db, PrismaClient, Project } from '@deadletter/db';
import { PLAN_LIMITS, type ApiKeyScope } from '@deadletter/shared';
import { writeAudit, type Actor } from '../audit';
import { NotFoundError, QuotaExceededError, UnauthenticatedError } from '../errors';
import { sha256Hex } from '../ids';
import type { ProjectAccess } from './orgs';

const KEY_FORMAT = /^(dl_live_[0-9a-f]{12})_[A-Za-z0-9_-]{32,64}$/;

/**
 * `dl_live_<12 hex>_<43 chars>`: the prefix identifies the key (stored, shown in the UI), the rest is 256 bits of
 * secret. Only SHA-256 of the whole key is stored; a fast hash is right here because the secret is random, not a
 * human-chosen password.
 */
export function generateApiKey() {
  const prefix = `dl_live_${randomBytes(6).toString('hex')}`;
  const key = `${prefix}_${randomBytes(32).toString('base64url')}`;
  return { key, prefix, keyHash: sha256Hex(key) };
}

export const publicApiKey = (k: ApiKey, now = new Date()) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  scopes: k.scopes,
  createdAt: k.createdAt,
  lastUsedAt: k.lastUsedAt,
  expiresAt: k.expiresAt,
  revokedAt: k.revokedAt,
  status: k.revokedAt ? 'REVOKED' : k.expiresAt && k.expiresAt <= now ? 'EXPIRED' : 'ACTIVE',
});

export async function listApiKeys(db: Db, projectId: string) {
  const rows = await db.apiKey.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  return rows.map((k) => publicApiKey(k));
}

const activeWhere = (projectId: string, now = new Date()) => ({
  projectId,
  revokedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
});

/** Returns the plaintext key exactly once; it cannot be recovered afterwards. */
export async function createApiKey(
  db: Db,
  actor: Actor,
  access: ProjectAccess,
  input: { name: string; scopes: ApiKeyScope[]; expiresInDays?: number },
) {
  const limit = PLAN_LIMITS[access.org.plan].apiKeysPerProject;
  if ((await db.apiKey.count({ where: activeWhere(access.project.id) })) >= limit) {
    throw new QuotaExceededError(`Your plan allows ${limit} active API keys per project`);
  }
  const g = generateApiKey();
  const row = await db.apiKey.create({
    data: {
      projectId: access.project.id,
      name: input.name,
      prefix: g.prefix,
      keyHash: g.keyHash,
      scopes: [...new Set(input.scopes)],
      createdById: actor.userId,
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
    },
  });
  await writeAudit(db, actor, {
    action: 'apikey.created',
    orgId: access.org.id,
    projectId: access.project.id,
    targetType: 'apikey',
    targetId: row.id,
    metadata: { name: row.name, prefix: row.prefix, scopes: row.scopes },
  });
  return { apiKey: publicApiKey(row), key: g.key };
}

export async function revokeApiKey(db: Db, actor: Actor, access: ProjectAccess, keyId: string) {
  const r = await db.apiKey.updateMany({
    where: { id: keyId, projectId: access.project.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (r.count === 0) throw new NotFoundError('API key');
  await writeAudit(db, actor, {
    action: 'apikey.revoked',
    orgId: access.org.id,
    projectId: access.project.id,
    targetType: 'apikey',
    targetId: keyId,
  });
}

/** Replace a key with a new one (same name, scopes and expiry) and revoke the old one in the same transaction. */
export async function rotateApiKey(db: PrismaClient, actor: Actor, access: ProjectAccess, keyId: string) {
  const old = await db.apiKey.findFirst({ where: { id: keyId, ...activeWhere(access.project.id) } });
  if (!old) throw new NotFoundError('API key');
  const g = generateApiKey();
  const created = await db.$transaction(async (tx) => {
    const revoked = await tx.apiKey.updateMany({
      where: { id: old.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count !== 1) throw new NotFoundError('API key');
    const row = await tx.apiKey.create({
      data: {
        projectId: old.projectId,
        name: old.name,
        prefix: g.prefix,
        keyHash: g.keyHash,
        scopes: old.scopes,
        createdById: actor.userId,
        expiresAt: old.expiresAt,
      },
    });
    await writeAudit(tx, actor, {
      action: 'apikey.rotated',
      orgId: access.org.id,
      projectId: access.project.id,
      targetType: 'apikey',
      targetId: row.id,
      metadata: { replaced: old.prefix, prefix: row.prefix },
    });
    return row;
  });
  return { apiKey: publicApiKey(created), key: g.key };
}

/**
 * Authenticate a raw API key (used by the ingestion API in Phase 3). Unknown, malformed, revoked and expired keys fail
 * with the same 401 code family; hashes are compared in constant time. `lastUsedAt` is written at most once a minute.
 */
export async function authenticateApiKey(
  db: Db,
  raw: string,
  now = new Date(),
): Promise<{ key: ApiKey; project: Project }> {
  const match = KEY_FORMAT.exec(raw.trim());
  if (!match) throw new UnauthenticatedError('Invalid API key');
  const found = await db.apiKey.findUnique({ where: { prefix: match[1] }, include: { project: true } });
  const expected = Buffer.from(found?.keyHash ?? '0'.repeat(64), 'hex');
  const actual = Buffer.from(sha256Hex(raw.trim()), 'hex');
  if (!found || !timingSafeEqual(expected, actual)) throw new UnauthenticatedError('Invalid API key');
  if (found.revokedAt) throw new UnauthenticatedError('This API key has been revoked');
  if (found.expiresAt && found.expiresAt <= now) throw new UnauthenticatedError('This API key has expired');
  if (!found.lastUsedAt || now.getTime() - found.lastUsedAt.getTime() > 60_000) {
    await db.apiKey.update({ where: { id: found.id }, data: { lastUsedAt: now } });
  }
  const { project, ...key } = found;
  return { key, project };
}
