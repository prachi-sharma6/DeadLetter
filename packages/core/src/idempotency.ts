import type { Db, Prisma } from '@deadletter/db';
import { IdempotencyKeyReusedError, RequestInProgressError } from './errors';
import { uuidv7 } from './ids';

export type BeginResult = { kind: 'new'; recordId: string } | { kind: 'replay'; statusCode: number; response: unknown };

export interface BeginInput {
  projectId: string;
  key: string;
  /** Hash of method + path + canonical body; reusing a key with a different request is rejected. */
  requestHash: string;
  /** How long a completed response is replayable. */
  ttlMs?: number;
  /** An IN_PROGRESS reservation older than this is assumed abandoned (crashed request) and may be taken over. */
  staleAfterMs?: number;
  now?: Date;
}

/**
 * Reserve an Idempotency-Key before doing the work. Exactly one concurrent request with a given key gets `new`; the
 * rest get REQUEST_IN_PROGRESS until it completes, after which they receive the stored response (`replay`).
 */
export async function beginIdempotentRequest(db: Db, input: BeginInput): Promise<BeginResult> {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? 24 * 60 * 60_000;
  const staleAfterMs = input.staleAfterMs ?? 60_000;

  for (let attempt = 0; attempt < 2; attempt++) {
    const id = uuidv7();
    const inserted = await db.$executeRaw`
      INSERT INTO "IdempotencyRecord" ("id", "projectId", "key", "requestHash", "state", "createdAt", "expiresAt")
      VALUES (${id}::uuid, ${input.projectId}::uuid, ${input.key}, ${input.requestHash}, 'IN_PROGRESS', ${now}, ${new Date(now.getTime() + ttlMs)})
      ON CONFLICT ("projectId", "key") DO NOTHING`;
    if (inserted === 1) return { kind: 'new', recordId: id };

    const existing = await db.idempotencyRecord.findUnique({
      where: { projectId_key: { projectId: input.projectId, key: input.key } },
    });
    if (!existing) continue; // deleted between our insert and read; try once more
    if (existing.expiresAt <= now) {
      await db.idempotencyRecord.deleteMany({ where: { id: existing.id, expiresAt: existing.expiresAt } });
      continue;
    }
    if (existing.requestHash !== input.requestHash) throw new IdempotencyKeyReusedError();
    if (existing.state === 'COMPLETED') {
      return { kind: 'replay', statusCode: existing.statusCode ?? 200, response: existing.response };
    }
    if (now.getTime() - existing.createdAt.getTime() > staleAfterMs) {
      // Take over an abandoned reservation; the createdAt guard makes the takeover itself race-free.
      const taken = await db.idempotencyRecord.updateMany({
        where: { id: existing.id, state: 'IN_PROGRESS', createdAt: existing.createdAt },
        data: { createdAt: now },
      });
      if (taken.count === 1) return { kind: 'new', recordId: existing.id };
    }
    throw new RequestInProgressError();
  }
  throw new RequestInProgressError();
}

/** Store the final response so retries of the same request get exactly the same answer. */
export async function completeIdempotentRequest(
  db: Db,
  recordId: string,
  statusCode: number,
  response: Prisma.InputJsonValue,
): Promise<void> {
  await db.idempotencyRecord.update({ where: { id: recordId }, data: { state: 'COMPLETED', statusCode, response } });
}

/** Release the key after a server error so the client can retry the request for real. */
export async function abandonIdempotentRequest(db: Db, recordId: string): Promise<void> {
  await db.idempotencyRecord.deleteMany({ where: { id: recordId, state: 'IN_PROGRESS' } });
}

export async function pruneExpiredIdempotencyRecords(db: Db, now = new Date()): Promise<number> {
  return (await db.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: now } } })).count;
}
