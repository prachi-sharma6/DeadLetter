import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_CONFIG,
  RETRY_LIMITS,
  baseDelayMs,
  decideRetry,
  matchesErrorPattern,
  resolvePolicy,
  retryDelayMs,
  type PolicyCandidate,
  type RetryConfig,
} from './retry';

const exp = { initialDelayMs: 1_000, maxDelayMs: 30_000, backoff: 'EXPONENTIAL' as const, jitter: 'NONE' as const };

describe('backoff', () => {
  it('exponential: min(initial * 2^(n-1), max)', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => baseDelayMs(n, exp))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });
  it('linear and fixed', () => {
    expect([1, 2, 3].map((n) => baseDelayMs(n, { ...exp, backoff: 'LINEAR' }))).toEqual([1000, 2000, 3000]);
    expect([1, 5, 9].map((n) => baseDelayMs(n, { ...exp, backoff: 'FIXED' }))).toEqual([1000, 1000, 1000]);
  });
  it('never overflows or goes negative, even with nonsense input', () => {
    expect(baseDelayMs(1_000_000, exp)).toBe(30_000);
    expect(baseDelayMs(0, exp)).toBe(1_000);
    expect(baseDelayMs(-5, exp)).toBe(1_000);
    expect(baseDelayMs(3, { ...exp, initialDelayMs: -10 })).toBe(0);
  });
  it('treats a max below the initial delay as the initial delay', () => {
    expect(baseDelayMs(4, { ...exp, initialDelayMs: 5_000, maxDelayMs: 1_000 })).toBe(5_000);
  });
  it('never exceeds the global hard cap', () => {
    expect(baseDelayMs(60, { ...exp, maxDelayMs: Number.MAX_SAFE_INTEGER })).toBe(RETRY_LIMITS.maxDelayMs);
  });
});

describe('jitter', () => {
  it('FULL is uniform in [0, d) and EQUAL in [d/2, d)', () => {
    expect(retryDelayMs(3, { ...exp, jitter: 'FULL' }, () => 0)).toBe(0);
    expect(retryDelayMs(3, { ...exp, jitter: 'FULL' }, () => 0.5)).toBe(2000);
    expect(retryDelayMs(3, { ...exp, jitter: 'EQUAL' }, () => 0)).toBe(2000);
    expect(retryDelayMs(3, { ...exp, jitter: 'EQUAL' }, () => 0.999)).toBe(3998);
  });
  it('stays within bounds over many random draws', () => {
    for (let i = 0; i < 1_000; i++) {
      const full = retryDelayMs(5, { ...exp, jitter: 'FULL' });
      const equal = retryDelayMs(5, { ...exp, jitter: 'EQUAL' });
      expect(full).toBeGreaterThanOrEqual(0);
      expect(full).toBeLessThan(16_000);
      expect(equal).toBeGreaterThanOrEqual(8_000);
      expect(equal).toBeLessThan(16_000);
    }
  });
  it('NONE returns the base delay', () => {
    expect(retryDelayMs(2, exp, () => 0.9)).toBe(2000);
  });
});

describe('error patterns', () => {
  it('matches exact names case-insensitively and Prefix* wildcards', () => {
    expect(matchesErrorPattern('TimeoutError', 'timeouterror')).toBe(true);
    expect(matchesErrorPattern('Http*', 'HttpError_503')).toBe(true);
    expect(matchesErrorPattern('Http*', 'NetworkError')).toBe(false);
    expect(matchesErrorPattern('  ', 'x')).toBe(false);
    expect(matchesErrorPattern('X', null)).toBe(false);
  });
});

describe('decideRetry', () => {
  const cfg: RetryConfig = { ...DEFAULT_RETRY_CONFIG, maxAttempts: 3, initialDelayMs: 100 };

  it('retries until attempts are exhausted, then dead-letters (bounded)', () => {
    expect(decideRetry(1, 'E', cfg)).toMatchObject({ retry: true, delayMs: 100 });
    expect(decideRetry(2, 'E', cfg)).toMatchObject({ retry: true, delayMs: 200 });
    expect(decideRetry(3, 'E', cfg)).toMatchObject({ retry: false, outcome: 'DEAD_LETTER' });
    expect(decideRetry(99, 'E', cfg)).toMatchObject({ retry: false, outcome: 'DEAD_LETTER' });
  });
  it('non-retryable errors fail immediately and win over the retryable list', () => {
    const c = { ...cfg, retryableErrors: ['Http*'], nonRetryableErrors: ['HttpError_400'] };
    expect(decideRetry(1, 'HttpError_503', c).retry).toBe(true);
    expect(decideRetry(1, 'HttpError_400', c)).toMatchObject({ retry: false, outcome: 'FAILED' });
  });
  it('only retries listed types when a retryable list exists', () => {
    expect(decideRetry(1, 'Other', { ...cfg, retryableErrors: ['Timeout*'] })).toMatchObject({ outcome: 'FAILED' });
    expect(decideRetry(1, null, { ...cfg, retryableErrors: ['Timeout*'] })).toMatchObject({ outcome: 'FAILED' });
  });
  it('respects the client saying an error is not retryable', () => {
    expect(decideRetry(1, 'E', cfg, { clientSaysRetryable: false })).toMatchObject({ outcome: 'FAILED' });
  });
  it('caps attempts at the global limit even if a policy asks for more', () => {
    expect(decideRetry(RETRY_LIMITS.maxAttempts, 'E', { ...cfg, maxAttempts: 10_000 })).toMatchObject({
      outcome: 'DEAD_LETTER',
    });
  });
  it('treats maxAttempts below 1 as a single attempt', () => {
    expect(decideRetry(1, 'E', { ...cfg, maxAttempts: 0 })).toMatchObject({ outcome: 'DEAD_LETTER' });
  });
});

describe('policy precedence', () => {
  const base = { ...DEFAULT_RETRY_CONFIG, enabled: true, priority: 0, queueName: null, jobType: null };
  const p = (id: string, o: Partial<PolicyCandidate> = {}): PolicyCandidate => ({
    ...base,
    id,
    createdAt: new Date(0),
    ...o,
  });
  const job = { queueName: 'emails', type: 'send' };

  it('higher priority beats specificity', () => {
    expect(
      resolvePolicy([p('specific', { queueName: 'emails', jobType: 'send' }), p('hi', { priority: 5 })], job)?.id,
    ).toBe('hi');
  });
  it('more specific wins at equal priority', () => {
    const list = [p('any'), p('queue', { queueName: 'emails' }), p('both', { queueName: 'emails', jobType: 'send' })];
    expect(resolvePolicy(list, job)?.id).toBe('both');
    expect(resolvePolicy(list.slice(0, 2), job)?.id).toBe('queue');
  });
  it('oldest wins a full tie', () => {
    expect(resolvePolicy([p('new', { createdAt: new Date(2) }), p('old', { createdAt: new Date(1) })], job)?.id).toBe(
      'old',
    );
  });
  it('ignores disabled and non-matching policies', () => {
    expect(resolvePolicy([p('off', { enabled: false }), p('other', { queueName: 'payments' })], job)).toBeNull();
  });
});
