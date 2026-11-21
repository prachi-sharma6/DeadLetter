import os from 'node:os';
import { createDb, pingDb } from '@deadletter/db';
import {
  closeRedis,
  createLogger,
  createRedis,
  installCrashHandlers,
  installGracefulShutdown,
} from '@deadletter/runtime';
import { loadWorkerConfig } from './config';
import { startHeartbeat } from './heartbeat';

// Phase 0 skeleton: connects, heartbeats and shuts down cleanly. Job processing arrives in Phase 4.
const config = loadWorkerConfig();
const logger = createLogger({ service: 'worker', level: config.LOG_LEVEL, pretty: config.LOG_PRETTY });
installCrashHandlers(logger);

const workerId = `${os.hostname()}:${process.pid}`;
const db = createDb({ url: config.DATABASE_URL, poolMax: config.DATABASE_POOL_MAX });
const redis = createRedis({ url: config.REDIS_URL, name: 'worker', logger, role: 'queue' });

await pingDb(db);
const heartbeat = startHeartbeat({ redis, workerId, logger });
logger.info({ workerId, version: config.GIT_SHA }, 'worker started');

installGracefulShutdown({
  logger,
  steps: [
    { name: 'heartbeat', run: () => heartbeat.stop() },
    { name: 'redis', run: () => closeRedis(redis) },
    { name: 'db', run: () => db.$disconnect() },
  ],
});
