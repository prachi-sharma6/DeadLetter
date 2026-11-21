import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EnvValidationError, parseEnv } from './env';

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.url(),
  SECRET: z.string().min(32),
});

describe('parseEnv', () => {
  it('parses, coerces and applies defaults', () => {
    const env = parseEnv(schema, { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', SECRET: 'x'.repeat(32) });
    expect(env.PORT).toBe(4000);
  });

  it('treats empty strings as unset so defaults apply', () => {
    const env = parseEnv(schema, { PORT: '', DATABASE_URL: 'postgresql://localhost/db', SECRET: 'x'.repeat(32) });
    expect(env.PORT).toBe(4000);
  });

  it('reports every invalid variable at once without leaking values', () => {
    const secret = 'too-short-secret-value';
    try {
      parseEnv(schema, { PORT: 'abc', SECRET: secret });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const err = e as EnvValidationError;
      expect(err.issues.map((i) => i.split(':')[0])).toEqual(
        expect.arrayContaining(['PORT', 'DATABASE_URL', 'SECRET']),
      );
      expect(err.message).not.toContain(secret);
    }
  });
});
