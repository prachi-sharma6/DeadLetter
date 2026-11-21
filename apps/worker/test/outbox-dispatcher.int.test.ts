import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { createDb } from '@deadletter/db';
import { truncateAllTables } from '@deadletter/db/testing';
import { addOutboxMessages, type OutboxPublisher } from '@deadletter/core';
import { BULL_PREFIX, closeRedis, createLogger, createRedis } from '@deadletter/runtime';
import { bullPublisher, startOutboxDispatcher } from '../src/outbox-dispatcher';

// Real Postgres + Redis: messages written to the outbox end up as BullMQ jobs exactly once.
const logger = createLogger({ service: 'worker-test', level: 'silent' });
const db = createDb({ url: process.env.DATABASE_URL!, poolMax: 5 });
const redis = createRedis({ url: process.env.REDIS_URL!, name: 'dispatcher-test', logger, role: 'queue' });
const queue = new Queue('dl-jobs-test', { connection: redis, prefix: BULL_PREFIX });

beforeAll(() => queue.waitUntilReady());
beforeEach(async () => {
  await truncateAllTables(db);
  await queue.obliterate({ force: true });
});
afterAll(async () => {
  await queue.close();
  await closeRedis(redis);
  await db.$disconnect();
});

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 5_000) => {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('outbox dispatcher', () => {
  it('moves committed outbox messages into the queue, keyed by dedupeKey', async () => {
    await db.$transaction((tx) =>
      addOutboxMessages(tx, [
        { topic: 'attempt.dispatch', payload: { jobId: 'a' }, dedupeKey: 'attempt.a.1' },
        { topic: 'attempt.dispatch', payload: { jobId: 'b' }, dedupeKey: 'attempt.b.1' },
      ]),
    );
    const d = startOutboxDispatcher({ db, publisher: bullPublisher(queue), logger, minIdleMs: 20 });
    await waitFor(async () => (await db.outboxMessage.count({ where: { dispatchedAt: null } })) === 0);
    await d.stop();

    const job = await queue.getJob('attempt.a.1');
    expect(job?.name).toBe('attempt.dispatch');
    expect(job?.data).toEqual({ jobId: 'a' });
    expect(await queue.getJobCountByTypes('waiting', 'delayed', 'prioritized')).toBe(2);
  });

  it('does not create a second queue job when a message is published again (crash after publish)', async () => {
    const pub = bullPublisher(queue);
    const m = { id: 1n, topic: 't', payload: { x: 1 }, dedupeKey: 'dup.1' };
    await pub.publish(m);
    await pub.publish(m);
    expect(await queue.getJobCountByTypes('waiting', 'delayed', 'prioritized')).toBe(1);
  });

  it('keeps going after publish errors and delivers once the queue recovers', async () => {
    await addOutboxMessages(db, [{ topic: 't', payload: {}, dedupeKey: 'flaky.1' }]);
    let failures = 1;
    const real = bullPublisher(queue);
    const flaky: OutboxPublisher = {
      async publish(m) {
        if (failures-- > 0) throw new Error('redis unavailable');
        await real.publish(m);
      },
    };
    const d = startOutboxDispatcher({ db, publisher: flaky, logger, minIdleMs: 20, maxIdleMs: 50 });
    // first attempt fails and is rescheduled ~1s later by the outbox backoff
    await waitFor(async () => (await queue.getJob('flaky.1')) !== undefined, 5_000);
    await d.stop();
    expect(await db.outboxMessage.findUniqueOrThrow({ where: { dedupeKey: 'flaky.1' } })).toMatchObject({
      attempts: 1,
    });
  });

  it('stops promptly even while idle', async () => {
    const d = startOutboxDispatcher({
      db,
      publisher: bullPublisher(queue),
      logger,
      minIdleMs: 10_000,
      maxIdleMs: 10_000,
    });
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await d.stop();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
