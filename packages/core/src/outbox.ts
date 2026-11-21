import type { Db, Prisma, PrismaClient } from '@deadletter/db';

/** BullMQ job ids and Redis keys must stay simple; enforce it where messages are created. */
const DEDUPE_KEY = /^[A-Za-z0-9._-]{1,200}$/;

export interface OutboxInput {
  topic: string;
  payload: Prisma.InputJsonValue;
  /** Stable key for this unit of work (e.g. `attempt.<jobId>.<n>`). Re-adding the same key is a no-op. */
  dedupeKey: string;
  availableAt?: Date;
}

export interface OutboxMessageOut {
  id: bigint;
  topic: string;
  payload: unknown;
  dedupeKey: string;
}

/** Delivers one message to the queue. Must be idempotent per `dedupeKey` (dispatch is at-least-once). */
export interface OutboxPublisher {
  publish(message: OutboxMessageOut): Promise<void>;
}

/**
 * Record queue work in the caller's transaction. If the transaction rolls back, the message never existed; if it
 * commits, the dispatcher will deliver it even if Redis is down right now or this process crashes next.
 */
export async function addOutboxMessages(tx: Db, messages: OutboxInput[]): Promise<void> {
  for (const m of messages) {
    if (!DEDUPE_KEY.test(m.dedupeKey)) throw new Error(`invalid outbox dedupeKey "${m.dedupeKey}"`);
  }
  // ON CONFLICT DO NOTHING: a plain insert would abort the caller's whole transaction on a duplicate key.
  await tx.outboxMessage.createMany({
    data: messages.map((m) => ({
      topic: m.topic,
      payload: m.payload,
      dedupeKey: m.dedupeKey,
      availableAt: m.availableAt,
    })),
    skipDuplicates: true,
  });
}

export interface DispatchResult {
  dispatched: number;
  failed: number;
}

const retryBackoffMs = (attempts: number) => Math.min(1_000 * 2 ** Math.min(attempts, 10), 5 * 60_000);

/**
 * Deliver one batch of due messages. Rows are claimed with `FOR UPDATE SKIP LOCKED`, so any number of dispatchers can
 * run concurrently without delivering a message twice at the same time. A message is marked dispatched only after the
 * publisher succeeded; a crash in between means it is published again later, which the idempotent publisher absorbs.
 * Failed publishes are retried with exponential backoff (1 s … 5 min).
 */
export async function dispatchOutboxBatch(
  db: PrismaClient,
  publisher: OutboxPublisher,
  opts: { batchSize?: number } = {},
): Promise<DispatchResult> {
  const batchSize = opts.batchSize ?? 50;
  return db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<(OutboxMessageOut & { attempts: number })[]>`
        SELECT "id", "topic", "payload", "dedupeKey", "attempts"
        FROM "OutboxMessage"
        WHERE "dispatchedAt" IS NULL AND "availableAt" <= now()
        ORDER BY "id"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED`;
      const done: bigint[] = [];
      let failed = 0;
      for (const row of rows) {
        try {
          await publisher.publish(row);
          done.push(row.id);
        } catch (err) {
          failed++;
          await tx.outboxMessage.update({
            where: { id: row.id },
            data: {
              attempts: { increment: 1 },
              lastError: String((err as Error).message ?? err).slice(0, 500),
              availableAt: new Date(Date.now() + retryBackoffMs(row.attempts)),
            },
          });
        }
      }
      if (done.length) {
        await tx.outboxMessage.updateMany({ where: { id: { in: done } }, data: { dispatchedAt: new Date() } });
      }
      return { dispatched: done.length, failed };
    },
    { timeout: 30_000, maxWait: 5_000 },
  );
}

/** Delete dispatched messages older than `olderThan` (retention). Returns the number removed. */
export async function pruneDispatchedOutbox(db: Db, olderThan: Date): Promise<number> {
  const r = await db.outboxMessage.deleteMany({ where: { dispatchedAt: { lt: olderThan } } });
  return r.count;
}
