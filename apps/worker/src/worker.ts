import os from 'node:os';
import { Queue } from 'bullmq';
import { assertUtcSession, pingDb, type PrismaClient } from '@deadletter/db';
import { BULL_PREFIX, JOBS_QUEUE, closeRedis, createRedis, type Logger } from '@deadletter/runtime';
import { startHeartbeat } from './heartbeat';
import { bullPublisher, startOutboxDispatcher } from './outbox-dispatcher';

export interface WorkerDeps {
  db: PrismaClient;
  redisUrl: string;
  logger: Logger;
  version: string;
}

export interface RunningWorker {
  workerId: string;
  /** Stop taking work, finish in-flight work, release the worker's own connections. Does not close `db`. */
  stop: () => Promise<void>;
}

/**
 * Start the background worker. Used by the standalone worker process (apps/worker/src/main.ts) and, on hosts that only
 * allow one service, inside the API process (RUN_WORKER=true). The worker owns its Redis connection because queue
 * connections must block and retry forever, unlike the API's fail-fast connection.
 *
 * Phase 1: heartbeat + outbox dispatcher. Attempt processing arrives in Phase 4.
 */
export async function startWorker({ db, redisUrl, logger, version }: WorkerDeps): Promise<RunningWorker> {
  const log = logger.child({ component: 'worker' });
  const workerId = `${os.hostname()}:${process.pid}`;
  // Check the database before opening any connection, so a failed (and retried) start never leaks Redis connections.
  await pingDb(db);
  await assertUtcSession(db);
  const redis = createRedis({ url: redisUrl, name: 'worker', logger: log, role: 'queue' });

  const queue = new Queue(JOBS_QUEUE, { connection: redis, prefix: BULL_PREFIX });
  queue.on('error', (err) => log.warn({ err: err.message }, 'queue error'));
  const dispatcher = startOutboxDispatcher({ db, publisher: bullPublisher(queue), logger: log });
  const heartbeat = startHeartbeat({ redis, workerId, logger: log });
  log.info({ workerId, version }, 'worker started');

  return {
    workerId,
    async stop() {
      await dispatcher.stop();
      await heartbeat.stop();
      await queue.close();
      await closeRedis(redis);
      log.info({ workerId }, 'worker stopped');
    },
  };
}
