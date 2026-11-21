import { describe, expect, it } from 'vitest';
import { REDACTED, maskEmails, redactText, redactValue } from './redact';
import { errorGroupTitle, normalizeErrorMessage, stackSignature } from './errors';

describe('redaction', () => {
  it('redacts sensitive keys at any depth, ignoring case and separators', () => {
    const out = redactValue({
      user: { Password: 'p', 'api-key': 'k', ok: 1 },
      list: [{ Access_Token: 't' }],
      headers: { Authorization: 'Bearer x', 'Set-Cookie': 'c' },
    }) as { user: unknown; list: Array<Record<string, unknown>>; headers: unknown };
    expect(out.user).toEqual({ Password: REDACTED, 'api-key': REDACTED, ok: 1 });
    expect(out.list[0]?.Access_Token).toBe(REDACTED);
    expect(out.headers).toEqual({ Authorization: REDACTED, 'Set-Cookie': REDACTED });
  });

  it('applies project-configured extra keys', () => {
    expect(redactValue({ phone: '123', name: 'a' }, { extraKeys: ['Phone'] })).toEqual({ phone: REDACTED, name: 'a' });
  });

  it('removes credentials embedded in strings', () => {
    expect(redactText('auth Bearer abcdefgh12345 and dl_live_0123456789ab_secretsecret')).toBe(
      `auth Bearer ${REDACTED} and ${REDACTED}`,
    );
    expect(maskEmails('mail bob@example.com now')).toBe('mail [EMAIL] now');
  });

  it('bounds depth, node count and string length', () => {
    let deep: object = { v: 1 };
    for (let i = 0; i < 50; i++) deep = { n: deep };
    expect(JSON.stringify(redactValue(deep))).toContain('[MAX_DEPTH]');
    expect(
      JSON.stringify(
        redactValue(
          Array.from({ length: 100 }, (_, i) => i),
          { maxNodes: 10 },
        ),
      ),
    ).toContain('[TRUNCATED]');
    expect(redactValue('x'.repeat(50), { maxStringLength: 10 })).toBe(`${'x'.repeat(10)}…[40 more chars]`);
  });

  it('passes primitives through untouched', () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBeNull();
    expect(redactValue(true)).toBe(true);
  });
});

describe('error normalization', () => {
  it('collapses messages that differ only in variable data', () => {
    const a = normalizeErrorMessage(
      'Failed to email bob@x.com for order_123 after 3000ms (id 550e8400-e29b-41d4-a716-446655440000)',
    );
    const b = normalizeErrorMessage(
      'Failed to email amy@y.org for order_987 after 15ms (id 123e4567-e89b-12d3-a456-426614174000)',
    );
    expect(a).toBe(b);
    expect(a).toContain('<email>');
    expect(a).toContain('order_<id>');
  });

  it('keeps HTTP status codes distinct when the message is about HTTP', () => {
    expect(normalizeErrorMessage('Request failed with status 429')).not.toBe(
      normalizeErrorMessage('Request failed with status 503'),
    );
    expect(normalizeErrorMessage('HTTP 429 Too Many Requests')).toBe('HTTP 429 Too Many Requests');
  });

  it('normalizes plain numbers when the message is not about HTTP', () => {
    expect(normalizeErrorMessage('Retried 429 rows')).toBe('Retried <n> rows');
  });

  it('keeps genuinely different errors apart and handles empty input', () => {
    expect(normalizeErrorMessage('Connection refused')).not.toBe(normalizeErrorMessage('Invalid credentials'));
    expect(normalizeErrorMessage(undefined)).toBe('');
    expect(normalizeErrorMessage('x'.repeat(1000))).toHaveLength(300);
  });

  it('replaces URLs, hex, timestamps and quoted values', () => {
    expect(
      normalizeErrorMessage(
        'GET https://api.example.com/v1/a?b=c failed at 2026-11-21T10:00:00Z with "boom" 0xdeadbeef',
      ),
    ).toBe('GET <url> failed at <ts> with <str> <hex>');
  });
});

describe('stack signature', () => {
  it('uses app frames only, without line numbers (POSIX and Windows paths)', () => {
    const posix = `Error: x\n    at send (/app/src/mail.ts:10:5)\n    at node:internal/x (node:internal/x:1:1)\n    at lib (/app/node_modules/lib/i.js:3:3)\n    at run (/app/src/worker.ts:22:1)`;
    expect(stackSignature(posix)).toBe('send@src/mail.ts|run@src/worker.ts');
    const win = `Error: x\n    at send (C:\\app\\src\\mail.ts:10:5)\n    at Object.<anonymous> (C:\\app\\src\\main.ts:1:1)`;
    expect(stackSignature(win)).toBe('send@src/mail.ts|Object.<anonymous>@src/main.ts');
  });

  it('is stable across deploys that only move line numbers', () => {
    expect(stackSignature('Error\n    at f (/a/b/c.ts:1:1)')).toBe(stackSignature('Error\n    at f (/a/b/c.ts:99:7)'));
  });

  it('handles anonymous frames, frame limits and empty stacks', () => {
    expect(stackSignature('Error\n    at /a/b/c.ts:1:1')).toBe('<anonymous>@b/c.ts');
    expect(stackSignature('Error\n    at a (/x/1.ts:1:1)\n    at b (/x/2.ts:1:1)', 1)).toBe('a@x/1.ts');
    expect(stackSignature(null)).toBe('');
  });
});

describe('errorGroupTitle', () => {
  it('combines type and message and truncates long messages', () => {
    expect(errorGroupTitle('TimeoutError', 'took <n>ms')).toBe('TimeoutError: took <n>ms');
    expect(errorGroupTitle('E', '')).toBe('E');
    expect(errorGroupTitle('E', 'm'.repeat(100))).toHaveLength(83);
  });
});
