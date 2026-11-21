import os from 'node:os';
import { pingDb, type PrismaClient } from '@deadletter/db';
import { closeRedis, createRedis, type Logger } from '@deadletter/runtime';
import { startHeartbeat } from './heartbeat';

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
 * Phase 0: heartbeat only. Job processing arrives in Phase 4.
 */
export async function startWorker({ db, redisUrl, logger, version }: WorkerDeps): Promise<RunningWorker> {
  const log = logger.child({ component: 'worker' });
  const workerId = `${os.hostname()}:${process.pid}`;
  const redis = createRedis({ url: redisUrl, name: 'worker', logger: log, role: 'queue' });
  await pingDb(db);
  const heartbeat = startHeartbeat({ redis, workerId, logger: log });
  log.info({ workerId, version }, 'worker started');
  return {
    workerId,
    async stop() {
      await heartbeat.stop();
      await closeRedis(redis);
      log.info({ workerId }, 'worker stopped');
    },
  };
}
