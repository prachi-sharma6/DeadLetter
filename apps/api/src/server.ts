import { createServer } from 'node:http';
import { NonUtcSessionError, assertUtcSession, createDb } from '@deadletter/db';
import {
  closeRedis,
  createLogger,
  createRedis,
  installCrashHandlers,
  installGracefulShutdown,
  retryUntil,
} from '@deadletter/runtime';
import { startWorker, type RunningWorker } from '@deadletter/worker';
import { createApp } from './app';
import { loadApiConfig } from './config';

const config = loadApiConfig();
const logger = createLogger({ service: 'api', level: config.LOG_LEVEL, pretty: config.LOG_PRETTY });
installCrashHandlers(logger);

const db = createDb({ url: config.DATABASE_URL, poolMax: config.DATABASE_POOL_MAX, caCert: config.DATABASE_CA_CERT });
const redis = createRedis({ url: config.REDIS_URL, name: 'api', logger, role: 'request' });
const app = createApp({ config, logger, db, redis });

const server = createServer(app);
server.requestTimeout = 30_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 65_000; // longer than common proxy idle timeouts to avoid 502s on reused connections

// The HTTP server starts first and never waits for dependencies: if the database is briefly down at boot, the app stays
// up and reports "degraded" instead of crash-looping. Dependency-bound startup work runs in the background with retries.
server.listen(config.PORT, () =>
  logger.info({ port: config.PORT, version: config.GIT_SHA, worker: config.RUN_WORKER }, 'api listening'),
);

const startup = new AbortController();
let worker: RunningWorker | undefined;

void (async () => {
  try {
    // A wrong database time zone would silently corrupt every timestamp: that one is fatal (docs/adr/0010).
    await retryUntil(() => assertUtcSession(db), {
      logger,
      label: 'database time zone check',
      isFatal: (e) => e instanceof NonUtcSessionError,
      signal: startup.signal,
    });
    // Single-service hosts (e.g. Render Free) run the worker inside this process; see docs/adr/0009.
    if (config.RUN_WORKER) {
      worker = await retryUntil(
        () => startWorker({ db, redisUrl: config.REDIS_URL, logger, version: config.GIT_SHA }),
        {
          logger,
          label: 'worker start',
          signal: startup.signal,
        },
      );
    }
  } catch (err) {
    logger.fatal({ err: (err as Error).message }, 'startup check failed; exiting');
    process.exit(1);
  }
})();

installGracefulShutdown({
  logger,
  steps: [
    { name: 'startup', run: () => startup.abort() },
    { name: 'http', run: () => new Promise<void>((resolve) => server.close(() => resolve())) },
    { name: 'worker', run: () => worker?.stop() },
    { name: 'redis', run: () => closeRedis(redis) },
    { name: 'db', run: () => db.$disconnect() },
  ],
});
