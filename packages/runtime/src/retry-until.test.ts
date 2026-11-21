import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';
import { retryUntil } from './retry-until';

const logger = createLogger({ service: 'test', level: 'silent' });

describe('retryUntil', () => {
  it('retries transient failures until success', async () => {
    let calls = 0;
    const result = await retryUntil(
      () => (++calls < 3 ? Promise.reject(new Error('db down')) : Promise.resolve('ok')),
      { logger, label: 'x', delayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('rethrows fatal errors immediately', async () => {
    let calls = 0;
    await expect(
      retryUntil(
        () => {
          calls++;
          return Promise.reject(new TypeError('misconfigured'));
        },
        { logger, label: 'x', delayMs: 1, isFatal: (e) => e instanceof TypeError },
      ),
    ).rejects.toThrow('misconfigured');
    expect(calls).toBe(1);
  });

  it('stops when aborted', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    const result = await retryUntil(() => Promise.reject(new Error('down')), {
      logger,
      label: 'x',
      delayMs: 5,
      signal: ctrl.signal,
    });
    expect(result).toBeUndefined();
  });
});
