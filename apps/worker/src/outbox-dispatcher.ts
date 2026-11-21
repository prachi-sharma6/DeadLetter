import type { Queue } from 'bullmq';
import type { PrismaClient } from '@deadletter/db';
import { dispatchOutboxBatch, type OutboxPublisher } from '@deadletter/core';
import type { Logger } from '@deadletter/runtime';

/**
 * Publishes outbox messages to BullMQ. The message's dedupeKey becomes the BullMQ job id, and BullMQ ignores `add` for
 * an id it already holds, so re-dispatching a message after a crash never creates a second queue job.
 */
export function bullPublisher(queue: Queue): OutboxPublisher {
  return {
    async publish(m) {
      await queue.add(m.topic, m.payload, {
        jobId: m.dedupeKey,
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 24 * 3_600, count: 5_000 },
      });
    },
  };
}

export interface DispatcherOptions {
  db: PrismaClient;
  publisher: OutboxPublisher;
  logger: Logger;
  batchSize?: number;
  /** Poll delay when the outbox was empty; doubles up to maxIdleMs, resets as soon as work appears. */
  minIdleMs?: number;
  maxIdleMs?: number;
}

/**
 * Background loop that drains the outbox. Safe to run in several processes at once (rows are claimed with
 * FOR UPDATE SKIP LOCKED). Errors (database or Redis briefly unavailable) are logged and retried with backoff.
 */
export function startOutboxDispatcher(opts: DispatcherOptions) {
  const minIdle = opts.minIdleMs ?? 500;
  const maxIdle = opts.maxIdleMs ?? 2_000;
  let idle = minIdle;
  let stopped = false;
  let wake: (() => void) | null = null;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });

  const loop = (async () => {
    while (!stopped) {
      try {
        const r = await dispatchOutboxBatch(opts.db, opts.publisher, { batchSize: opts.batchSize ?? 50 });
        if (r.failed) opts.logger.warn({ failed: r.failed }, 'outbox publish failures; will retry with backoff');
        if (r.dispatched > 0) {
          idle = minIdle;
          continue; // more may be waiting
        }
      } catch (err) {
        opts.logger.error({ err: (err as Error).message }, 'outbox dispatch failed');
      }
      await sleep(idle);
      idle = Math.min(idle * 2, maxIdle);
    }
  })();

  return {
    /** Stop polling and wait for the batch in progress to finish. */
    async stop() {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}
