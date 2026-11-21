import { z } from 'zod';
import { parseEnv, withBuildVersion } from '@deadletter/shared';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const apiEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool.default(false),
  DATABASE_URL: z.url().refine((u) => /^postgres(ql)?:\/\//.test(u), 'must be a postgresql:// URL'),
  /** Connections per process. Free Postgres tiers allow few; API + worker together must stay under the limit. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  /** Optional PEM of the database provider's CA (Supabase); enables verified TLS. Public data, not a secret. */
  DATABASE_CA_CERT: z.string().includes('BEGIN CERTIFICATE', { message: 'must be a PEM certificate' }).optional(),
  REDIS_URL: z.url().refine((u) => /^rediss?:\/\//.test(u), 'must be a redis:// or rediss:// URL'),
  /** Public origin of the app, e.g. https://app.example.com. Used for CORS-free same-origin checks and links. */
  APP_ORIGIN: z.url(),
  /**
   * How to find the client IP behind reverse proxies (used for rate limits, sessions and audit):
   *  - `private`: trust only private/internal proxy addresses (10/8, 172.16/12, 192.168/16, loopback, link-local) and
   *    take the right-most public address. Correct for hosts whose proxy chain is internal (Render), and a client
   *    cannot spoof it: anything it puts in X-Forwarded-For ends up to the left of its real address.
   *  - a number: trust exactly that many proxy hops. 0 = use the socket address (no proxy).
   */
  TRUST_PROXY: z.union([z.literal('private'), z.coerce.number().int().min(0).max(5)]).default(0),
  /** Directory of the built web app to serve; unset in development (Vite serves it). */
  WEB_DIST_DIR: z.string().optional(),
  /** Also run the background worker inside the API process (for single-service free hosts). */
  RUN_WORKER: bool.default(false),
  /** Resend API key. Without it, production reports email as "not configured" instead of pretending to send. */
  RESEND_API_KEY: z.string().startsWith('re_', 'must be a Resend API key (re_…)').optional(),
  /** Sender, e.g. `DeadLetter <noreply@your-domain.com>`; the domain must be verified in Resend. */
  EMAIL_FROM: z.string().min(3).default('DeadLetter <onboarding@resend.dev>'),
  /** Turn off only in tests that exercise many requests; production must keep rate limits on. */
  RATE_LIMITS: z.enum(['on', 'off']).default('on'),
  /** Git commit of the running build, reported by /api/health. */
  GIT_SHA: z.string().default('dev'),
});

export type ApiConfig = z.output<typeof apiEnvSchema>;

export const loadApiConfig = (source: Record<string, string | undefined> = process.env): ApiConfig =>
  parseEnv(apiEnvSchema, withBuildVersion(source));
