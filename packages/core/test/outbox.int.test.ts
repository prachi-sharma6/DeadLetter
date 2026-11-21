import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addOutboxMessages,
  dispatchOutboxBatch,
  pruneDispatchedOutbox,
  type OutboxMessageOut,
  type OutboxPublisher,
} from '../src';
import { resetDb, testDb } from './fixtures';

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(() => db.$disconnect());

class RecordingPublisher implements OutboxPublisher {
  published: OutboxMessageOut[] = [];
  failKeys = new Set<string>();
  delayMs = 0;
  async publish(m: OutboxMessageOut) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failKeys.has(m.dedupeKey)) throw new Error('redis down');
    this.published.push(m);
  }
}

const msg = (k: string) => ({ topic: 'attempt.dispatch', payload: { k }, dedupeKey: k });

describe('outbox', () => {
  it('writes nothing when the surrounding transaction rolls back', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await addOutboxMessages(tx, [msg('a.1')]);
        throw new Error('business logic failed');
      }),
    ).rejects.toThrow('business logic failed');
    expect(await db.outboxMessage.count()).toBe(0);
  });

  it('ignores a duplicate dedupe key without aborting the transaction', async () => {
    await db.$transaction(async (tx) => {
      await addOutboxMessages(tx, [msg('a.1')]);
      await addOutboxMessages(tx, [msg('a.1'), msg('a.2')]);
      await tx.organization.create({ data: { name: 'still works', slug: 'still-works' } });
    });
    expect(await db.outboxMessage.count()).toBe(2);
  });

  it('rejects unsafe dedupe keys', async () => {
    await expect(addOutboxMessages(db, [msg('has:colon')])).rejects.toThrow(/invalid outbox dedupeKey/);
  });

  it('dispatches due messages in order and marks them dispatched', async () => {
    await addOutboxMessages(db, [msg('m.1'), msg('m.2'), msg('m.3')]);
    await addOutboxMessages(db, [{ ...msg('later.1'), availableAt: new Date(Date.now() + 60_000) }]);
    const pub = new RecordingPublisher();
    expect(await dispatchOutboxBatch(db, pub)).toEqual({ dispatched: 3, failed: 0 });
    expect(pub.published.map((m) => m.dedupeKey)).toEqual(['m.1', 'm.2', 'm.3']);
    expect(await dispatchOutboxBatch(db, pub)).toEqual({ dispatched: 0, failed: 0 });
    expect(await db.outboxMessage.count({ where: { dispatchedAt: null } })).toBe(1);
  });

  it('never hands the same message to two concurrent dispatchers', async () => {
    await addOutboxMessages(
      db,
      Array.from({ length: 60 }, (_, i) => msg(`c.${i}`)),
    );
    const pub = new RecordingPublisher();
    pub.delayMs = 5;
    const runs = await Promise.all(Array.from({ length: 5 }, () => dispatchOutboxBatch(db, pub, { batchSize: 20 })));
    let total = runs.reduce((s, r) => s + r.dispatched, 0);
    while (total < 60) total += (await dispatchOutboxBatch(db, pub, { batchSize: 20 })).dispatched;
    const keys = pub.published.map((m) => m.dedupeKey);
    expect(keys).toHaveLength(60);
    expect(new Set(keys).size).toBe(60);
  });

  it('keeps failed messages pending with backoff and the error recorded', async () => {
    await addOutboxMessages(db, [msg('ok.1'), msg('bad.1')]);
    const pub = new RecordingPublisher();
    pub.failKeys.add('bad.1');
    expect(await dispatchOutboxBatch(db, pub)).toEqual({ dispatched: 1, failed: 1 });
    const bad = await db.outboxMessage.findUniqueOrThrow({ where: { dedupeKey: 'bad.1' } });
    expect(bad).toMatchObject({ dispatchedAt: null, attempts: 1, lastError: 'redis down' });
    expect(bad.availableAt.getTime()).toBeGreaterThan(Date.now());
    // not due yet: the next run skips it
    expect(await dispatchOutboxBatch(db, pub)).toEqual({ dispatched: 0, failed: 0 });
  });

  it('prunes dispatched messages older than the cutoff only', async () => {
    await addOutboxMessages(db, [msg('p.1'), msg('p.2')]);
    await dispatchOutboxBatch(db, new RecordingPublisher(), { batchSize: 1 });
    expect(await pruneDispatchedOutbox(db, new Date(Date.now() + 1_000))).toBe(1);
    expect(await db.outboxMessage.count()).toBe(1);
  });
});
