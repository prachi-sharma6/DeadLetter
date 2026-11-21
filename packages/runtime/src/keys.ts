/** Redis key names shared by the API and worker. All DeadLetter keys use the `dl:` prefix. */

/** Sorted set: member = worker id, score = last heartbeat (epoch ms). */
export const WORKERS_KEY = 'dl:workers';
/** A worker whose last heartbeat is older than this is considered gone. */
export const WORKER_STALE_MS = 30_000;
export const WORKER_HEARTBEAT_MS = 5_000;
