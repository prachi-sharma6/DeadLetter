import { describe, expect, it } from 'vitest';
import { EnvValidationError } from '@deadletter/shared';
import { loadApiConfig } from './config';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  APP_ORIGIN: 'http://localhost:5173',
};

describe('API config', () => {
  it('accepts a minimal valid environment with safe defaults', () => {
    const c = loadApiConfig(valid);
    expect(c).toMatchObject({ PORT: 4000, NODE_ENV: 'development', TRUST_PROXY: 0, LOG_PRETTY: false });
  });

  it('refuses to start with a non-Postgres database URL or missing origin', () => {
    expect(() => loadApiConfig({ ...valid, DATABASE_URL: 'mysql://localhost/db' })).toThrow(EnvValidationError);
    expect(() => loadApiConfig({ DATABASE_URL: valid.DATABASE_URL, REDIS_URL: valid.REDIS_URL })).toThrow(/APP_ORIGIN/);
  });

  it('honours the platform-provided PORT', () => {
    expect(loadApiConfig({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });
});
