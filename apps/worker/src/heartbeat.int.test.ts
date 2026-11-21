import { afterAll, describe, expect, it } from 'vitest';
import { closeRedis, createLogger, createRedis, WORKERS_KEY } from '@deadletter/runtime';
import { startHeartbeat } from './heartbeat';

const logger = createLogger({ service: 'worker-test', level: 'silent' });
const redis = createRedis({ url: process.env.REDIS_URL!, name: 'worker-test', logger, role: 'queue' });

afterAll(() => closeRedis(redis));

describe('worker heartbeat', () => {
  it('registers, trims stale workers, and deregisters on stop', async () => {
    await redis.zadd(WORKERS_KEY, Date.now() - 10 * 60_000, 'ghost-worker');
    const hb = startHeartbeat({ redis, workerId: 'test-worker', logger, intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 120));
    expect(await redis.zscore(WORKERS_KEY, 'test-worker')).not.toBeNull();
    expect(await redis.zscore(WORKERS_KEY, 'ghost-worker')).toBeNull();
    await hb.stop();
    expect(await redis.zscore(WORKERS_KEY, 'test-worker')).toBeNull();
  });
});
