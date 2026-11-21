import { Redis, type RedisOptions } from 'ioredis';
import type { Logger } from './logger';

export interface RedisClientOptions {
  url: string;
  name: string;
  logger: Logger;
  /**
   * `request` connections (health checks, pub/sub publish, rate limits) fail fast while Redis is unreachable so HTTP
   * requests degrade instead of hanging. `queue` connections (BullMQ) must retry forever, as BullMQ requires.
   */
  role: 'request' | 'queue';
}

export function createRedis({ url, name, logger, role }: RedisClientOptions): Redis {
  const options: RedisOptions = {
    connectionName: `deadletter:${name}`,
    maxRetriesPerRequest: role === 'queue' ? null : 1,
    enableOfflineQueue: role === 'queue',
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (attempt) => Math.min(250 * 2 ** Math.min(attempt, 5), 5_000),
  };
  const client = new Redis(url, options);
  let wasReady = false;
  client.on('ready', () => {
    logger.info({ redis: name }, wasReady ? 'redis reconnected' : 'redis ready');
    wasReady = true;
  });
  client.on('error', (err: Error) => logger.warn({ redis: name, err: err.message }, 'redis error'));
  return client;
}

export async function closeRedis(client: Redis): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

/** Resolve once the client is connected and ready; reject after `timeoutMs`. Fail-fast clients reject commands until then. */
export function waitForRedis(client: Redis, timeoutMs = 10_000): Promise<void> {
  if (client.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('ready', onReady);
      reject(new Error(`redis not ready after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    client.once('ready', onReady);
  });
}

export type { Redis };
