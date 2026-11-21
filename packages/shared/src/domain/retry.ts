export const BACKOFF_STRATEGIES = ['EXPONENTIAL', 'LINEAR', 'FIXED'] as const;
export type BackoffStrategy = (typeof BACKOFF_STRATEGIES)[number];
export const JITTER_MODES = ['NONE', 'FULL', 'EQUAL'] as const;
export type JitterMode = (typeof JITTER_MODES)[number];

export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoff: BackoffStrategy;
  jitter: JitterMode;
  /** If non-empty, only these error types are retried. `Prefix*` matches by prefix. Case-insensitive. */
  retryableErrors: readonly string[];
  /** Never retried; wins over `retryableErrors`. */
  nonRetryableErrors: readonly string[];
}

/** Used when no policy matches a job. Documented in docs/adr and the dashboard. */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
  backoff: 'EXPONENTIAL',
  jitter: 'NONE',
  retryableErrors: [],
  nonRetryableErrors: [],
};

/** Hard caps that no policy can exceed, so a misconfiguration cannot create unbounded work. */
export const RETRY_LIMITS = { maxAttempts: 50, maxDelayMs: 7 * 24 * 60 * 60_000 } as const;

/**
 * Delay before the next attempt after attempt `attemptNumber` (1-based) failed, before jitter.
 *   EXPONENTIAL: min(initial × 2^(n−1), max)    LINEAR: min(initial × n, max)    FIXED: min(initial, max)
 */
export function baseDelayMs(
  attemptNumber: number,
  cfg: Pick<RetryConfig, 'initialDelayMs' | 'maxDelayMs' | 'backoff'>,
): number {
  const n = Math.max(1, Math.floor(attemptNumber));
  const initial = Math.max(0, cfg.initialDelayMs);
  const cap = Math.min(Math.max(initial, cfg.maxDelayMs), RETRY_LIMITS.maxDelayMs);
  let raw: number;
  if (cfg.backoff === 'LINEAR') raw = initial * n;
  else if (cfg.backoff === 'FIXED') raw = initial;
  else raw = initial * 2 ** Math.min(n - 1, 40); // exponent capped: 2^40 already exceeds any allowed delay
  return Math.min(Math.round(raw), cap);
}

/**
 * Delay including jitter. `random` returns [0, 1) and is injectable for deterministic tests.
 *   NONE: d    FULL: uniform[0, d)    EQUAL: d/2 + uniform[0, d/2)
 */
export function retryDelayMs(
  attemptNumber: number,
  cfg: Pick<RetryConfig, 'initialDelayMs' | 'maxDelayMs' | 'backoff' | 'jitter'>,
  random: () => number = Math.random,
): number {
  const d = baseDelayMs(attemptNumber, cfg);
  if (cfg.jitter === 'FULL') return Math.floor(random() * d);
  if (cfg.jitter === 'EQUAL') return Math.floor(d / 2 + random() * (d / 2));
  return d;
}

export function matchesErrorPattern(pattern: string, errorType: string | null | undefined): boolean {
  if (!errorType) return false;
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  const t = errorType.toLowerCase();
  return p.endsWith('*') ? t.startsWith(p.slice(0, -1)) : t === p;
}

export type RetryDecision =
  | { retry: true; delayMs: number; reason: string }
  | { retry: false; outcome: 'FAILED' | 'DEAD_LETTER'; reason: string };

/**
 * What happens after attempt `attemptNumber` failed with `errorType`. Bounded: never retries once the attempt count
 * reaches `maxAttempts` (capped at RETRY_LIMITS.maxAttempts).
 */
export function decideRetry(
  attemptNumber: number,
  errorType: string | null | undefined,
  cfg: RetryConfig,
  opts: { clientSaysRetryable?: boolean; random?: () => number } = {},
): RetryDecision {
  if (opts.clientSaysRetryable === false) {
    return { retry: false, outcome: 'FAILED', reason: 'The client reported the error as non-retryable' };
  }
  if (cfg.nonRetryableErrors.some((p) => matchesErrorPattern(p, errorType))) {
    return { retry: false, outcome: 'FAILED', reason: `Error type "${errorType}" is non-retryable` };
  }
  if (cfg.retryableErrors.length > 0 && !cfg.retryableErrors.some((p) => matchesErrorPattern(p, errorType))) {
    return {
      retry: false,
      outcome: 'FAILED',
      reason: `Error type "${errorType ?? 'unknown'}" is not in the retryable list`,
    };
  }
  const max = Math.min(Math.max(1, cfg.maxAttempts), RETRY_LIMITS.maxAttempts);
  if (attemptNumber >= max) {
    return { retry: false, outcome: 'DEAD_LETTER', reason: `Retries exhausted (${attemptNumber}/${max} attempts)` };
  }
  return {
    retry: true,
    delayMs: retryDelayMs(attemptNumber, cfg, opts.random),
    reason: `Attempt ${attemptNumber + 1}/${max}`,
  };
}

export interface PolicyCandidate extends RetryConfig {
  id: string;
  queueName: string | null;
  jobType: string | null;
  priority: number;
  enabled: boolean;
  createdAt: Date;
}

/**
 * Pick the policy for a job. Only enabled policies whose queue/type constraints match (null = any) apply.
 * Precedence: higher `priority` first, then more specific (queue+type > one of them > neither), then oldest.
 */
export function resolvePolicy<T extends PolicyCandidate>(
  policies: readonly T[],
  job: { queueName: string; type: string },
): T | null {
  const specificity = (p: T) => (p.queueName ? 1 : 0) + (p.jobType ? 1 : 0);
  const applicable = policies.filter(
    (p) =>
      p.enabled &&
      (p.queueName === null || p.queueName === job.queueName) &&
      (p.jobType === null || p.jobType === job.type),
  );
  applicable.sort(
    (a, b) =>
      b.priority - a.priority || specificity(b) - specificity(a) || a.createdAt.getTime() - b.createdAt.getTime(),
  );
  return applicable[0] ?? null;
}
