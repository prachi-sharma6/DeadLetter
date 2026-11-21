import { createDb } from '@deadletter/db';
import { createLogger, installCrashHandlers, installGracefulShutdown } from '@deadletter/runtime';
import { loadWorkerConfig } from './config';
import { startWorker } from './worker';

// Standalone worker process. See ./worker.ts for the worker itself.
const config = loadWorkerConfig();
const logger = createLogger({ service: 'worker', level: config.LOG_LEVEL, pretty: config.LOG_PRETTY });
installCrashHandlers(logger);

const db = createDb({ url: config.DATABASE_URL, poolMax: config.DATABASE_POOL_MAX, caCert: config.DATABASE_CA_CERT });
const worker = await startWorker({ db, redisUrl: config.REDIS_URL, logger, version: config.GIT_SHA });

installGracefulShutdown({
  logger,
  steps: [
    { name: 'worker', run: () => worker.stop() },
    { name: 'db', run: () => db.$disconnect() },
  ],
});
