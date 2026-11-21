import { z } from 'zod';
import { parseEnv, withBuildVersion } from '@deadletter/shared';

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
  DATABASE_URL: z.url().refine((u) => /^postgres(ql)?:\/\//.test(u), 'must be a postgresql:// URL'),
  /** Connections per process; see apps/api/src/config.ts. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  /** Optional PEM of the database provider's CA (Supabase); enables verified TLS. Public data, not a secret. */
  DATABASE_CA_CERT: z.string().includes('BEGIN CERTIFICATE', { message: 'must be a PEM certificate' }).optional(),
  REDIS_URL: z.url().refine((u) => /^rediss?:\/\//.test(u), 'must be a redis:// or rediss:// URL'),
  GIT_SHA: z.string().default('dev'),
});

export type WorkerConfig = z.output<typeof workerEnvSchema>;

export const loadWorkerConfig = (source: Record<string, string | undefined> = process.env): WorkerConfig =>
  parseEnv(workerEnvSchema, withBuildVersion(source));
