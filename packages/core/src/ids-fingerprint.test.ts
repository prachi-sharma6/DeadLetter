import { describe, expect, it } from 'vitest';
import { canonicalJson, hashJson, uuidv7 } from './ids';
import { errorIdentity } from './fingerprint';

describe('uuidv7', () => {
  it('produces valid version-7 RFC 4122 UUIDs', () => {
    for (let i = 0; i < 100; i++) {
      expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('encodes the timestamp and sorts by creation time, even within one millisecond', () => {
    const ids = Array.from({ length: 2_000 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    const t = Date.UTC(2030, 0, 1);
    expect(parseInt(uuidv7(t).replace(/-/g, '').slice(0, 12), 16)).toBeGreaterThanOrEqual(t);
  });
});

describe('canonical JSON', () => {
  it('ignores key order at every level but not array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe(
      '{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}',
    );
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
    expect(hashJson([1, 2])).not.toBe(hashJson([2, 1]));
  });
});

describe('errorIdentity', () => {
  const base = {
    errorType: 'TimeoutError',
    message: 'timed out after 3000ms',
    stack: 'Error\n    at f (/app/a.ts:1:1)',
    jobType: 'send',
    queueName: 'emails',
  };

  it('is stable across variable data and line numbers', () => {
    const a = errorIdentity(base);
    const b = errorIdentity({ ...base, message: 'timed out after 15ms', stack: 'Error\n    at f (/app/a.ts:90:4)' });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.title).toBe('TimeoutError: timed out after <n>ms');
  });

  it('separates same-looking errors from different types, code paths, job types or queues', () => {
    const fp = errorIdentity(base).fingerprint;
    expect(errorIdentity({ ...base, errorType: 'NetworkError' }).fingerprint).not.toBe(fp);
    expect(errorIdentity({ ...base, stack: 'Error\n    at g (/app/b.ts:1:1)' }).fingerprint).not.toBe(fp);
    expect(errorIdentity({ ...base, jobType: 'charge' }).fingerprint).not.toBe(fp);
    expect(errorIdentity({ ...base, queueName: 'payments' }).fingerprint).not.toBe(fp);
  });
});
