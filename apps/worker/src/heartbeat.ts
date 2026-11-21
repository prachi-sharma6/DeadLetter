import { WORKER_HEARTBEAT_MS, WORKER_STALE_MS, WORKERS_KEY, type Logger, type Redis } from '@deadletter/runtime';

/**
 * Publish liveness so the API can report how many workers are alive. Each beat also trims entries from workers that
 * died without deregistering. Failures are logged, never fatal: Redis may be briefly unavailable.
 */
export function startHeartbeat(opts: { redis: Redis; workerId: string; logger: Logger; intervalMs?: number }) {
  const beat = async () => {
    const now = Date.now();
    try {
      await opts.redis
        .multi()
        .zadd(WORKERS_KEY, now, opts.workerId)
        .zremrangebyscore(WORKERS_KEY, 0, now - WORKER_STALE_MS)
        .exec();
    } catch (err) {
      opts.logger.warn({ err: (err as Error).message }, 'heartbeat failed');
    }
  };
  void beat();
  const timer = setInterval(() => void beat(), opts.intervalMs ?? WORKER_HEARTBEAT_MS);
  return {
    async stop() {
      clearInterval(timer);
      await opts.redis.zrem(WORKERS_KEY, opts.workerId).catch(() => undefined);
    },
  };
}
