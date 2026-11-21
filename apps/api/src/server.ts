import { createServer } from 'node:http';
import { createDb } from '@deadletter/db';
import {
  closeRedis,
  createLogger,
  createRedis,
  installCrashHandlers,
  installGracefulShutdown,
  type ShutdownStep,
} from '@deadletter/runtime';
import { startWorker } from '@deadletter/worker';
import { createApp } from './app';
import { loadApiConfig } from './config';

const config = loadApiConfig();
const logger = createLogger({ service: 'api', level: config.LOG_LEVEL, pretty: config.LOG_PRETTY });
installCrashHandlers(logger);

const db = createDb({ url: config.DATABASE_URL, poolMax: config.DATABASE_POOL_MAX, caCert: config.DATABASE_CA_CERT });
const redis = createRedis({ url: config.REDIS_URL, name: 'api', logger, role: 'request' });
const app = createApp({ config, logger, db, redis });

// Single-service hosts (e.g. Render Free) run the worker inside this process; see docs/adr/0009.
const worker = config.RUN_WORKER
  ? await startWorker({ db, redisUrl: config.REDIS_URL, logger, version: config.GIT_SHA })
  : null;

const server = createServer(app);
server.requestTimeout = 30_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 65_000; // longer than common proxy idle timeouts to avoid 502s on reused connections

server.listen(config.PORT, () =>
  logger.info({ port: config.PORT, version: config.GIT_SHA, worker: worker !== null }, 'api listening'),
);

const steps: ShutdownStep[] = [
  { name: 'http', run: () => new Promise<void>((resolve) => server.close(() => resolve())) },
];
if (worker) steps.push({ name: 'worker', run: () => worker.stop() });
steps.push({ name: 'redis', run: () => closeRedis(redis) }, { name: 'db', run: () => db.$disconnect() });
installGracefulShutdown({ logger, steps });
