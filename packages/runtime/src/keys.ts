/** Redis key names shared by the API and worker. All DeadLetter keys use the `dl:` prefix. */

/** Sorted set: member = worker id, score = last heartbeat (epoch ms). */
export const WORKERS_KEY = 'dl:workers';
/** A worker whose last heartbeat is older than this is considered gone. */
export const WORKER_STALE_MS = 30_000;
export const WORKER_HEARTBEAT_MS = 5_000;

/** BullMQ key prefix: all queue keys live under `dl:bull:*`. */
export const BULL_PREFIX = 'dl:bull';
/**
 * The single shared queue every tenant's work flows through (docs/adr/0003). Per-project fairness and concurrency are
 * enforced in application code, so Redis connections stay constant no matter how many customers or queues exist.
 */
export const JOBS_QUEUE = 'dl-jobs';
