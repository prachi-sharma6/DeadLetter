import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { Prisma, PrismaClient } from './generated/client';

export * from './generated/client';

/** A Prisma client or an open interactive transaction; domain functions accept either. */
export type Db = PrismaClient | Prisma.TransactionClient;

export interface DbOptions {
  url: string;
  /** Free-tier Postgres plans allow few connections; keep the per-process pool small. */
  poolMax?: number;
  /**
   * PEM certificate of the database provider's CA (e.g. Supabase's). When set, the connection uses TLS and the server
   * certificate is fully verified against it. Do not also put `sslmode` in the URL.
   */
  caCert?: string;
}

export function createDb({ url, poolMax = 5, caCert }: DbOptions): PrismaClient {
  const pool = new pg.Pool({
    connectionString: url,
    max: poolMax,
    // node-postgres has no connect timeout by default; fail fast instead of hanging requests.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ...(caCert ? { ssl: { ca: normalizePem(caCert), rejectUnauthorized: true } } : {}),
  });
  return new PrismaClient({ adapter: new PrismaPg(pool), log: [{ level: 'error', emit: 'stdout' }] });
}

/**
 * Prisma's pg adapter sends timestamps as UTC wall-clock time without an offset; Postgres reads them in the *session*
 * time zone. A non-UTC session would silently store every instant shifted by its offset. The database default is set to
 * UTC by migration; this check makes the app refuse to start if that ever is not the case (docs/adr/0010).
 */
export class NonUtcSessionError extends Error {
  constructor(readonly timeZone: string) {
    super(
      `Database session time zone is "${timeZone}", expected UTC. Run migrations (they set the database default) ` +
        "or set it with: ALTER DATABASE <name> SET timezone TO 'UTC'",
    );
    this.name = 'NonUtcSessionError';
  }
}

/** Throws NonUtcSessionError on a misconfigured database; connection errors propagate unchanged. */
export async function assertUtcSession(db: Db): Promise<void> {
  const [row] = await db.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
  const tz = row?.tz ?? 'unknown';
  if (tz !== 'UTC' && tz !== 'Etc/UTC') throw new NonUtcSessionError(tz);
}

/** Accept PEMs pasted into single-line env var fields with literal `\n` sequences. */
export function normalizePem(pem: string): string {
  return pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
}

/** Cheap connectivity probe used by readiness checks. */
export async function pingDb(db: PrismaClient): Promise<void> {
  await db.$queryRaw`SELECT 1`;
}

/** True for Prisma's unique-constraint violation, optionally on a specific set of columns. */
export function isUniqueViolation(err: unknown, fields?: string[]): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  if (!fields) return true;
  const target = (err.meta?.target ??
    (err.meta as { driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } } })?.driverAdapterError?.cause
      ?.constraint?.fields) as string[] | string | undefined;
  const list = Array.isArray(target) ? target : typeof target === 'string' ? [target] : [];
  return fields.every((f) => list.some((t) => t.includes(f)));
}
