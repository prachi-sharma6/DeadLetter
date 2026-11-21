import type { Logger } from './logger';

export interface RetryUntilOptions {
  logger: Logger;
  label: string;
  /** Delay between attempts; doubles up to maxDelayMs. */
  delayMs?: number;
  maxDelayMs?: number;
  /** Errors for which retrying cannot help (misconfiguration). They are rethrown immediately. */
  isFatal?: (err: unknown) => boolean;
  /** Stop retrying (e.g. during shutdown); the returned promise then resolves to undefined. */
  signal?: AbortSignal;
}

/**
 * Keep calling `fn` until it succeeds. Used for startup work that needs a dependency (database, Redis) that may be
 * briefly unavailable: the process stays up and serves health checks instead of crash-looping.
 */
export async function retryUntil<T>(fn: () => Promise<T>, opts: RetryUntilOptions): Promise<T | undefined> {
  let delay = opts.delayMs ?? 1_000;
  const max = opts.maxDelayMs ?? 30_000;
  for (let attempt = 1; ; attempt++) {
    if (opts.signal?.aborted) return undefined;
    try {
      return await fn();
    } catch (err) {
      if (opts.isFatal?.(err)) throw err;
      opts.logger.warn({ err: (err as Error).message, attempt, retryInMs: delay }, `${opts.label} failed; retrying`);
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, delay);
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      });
    });
    delay = Math.min(delay * 2, max);
  }
}
