import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';

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
  const adapter = new PrismaPg({
    connectionString: url,
    max: poolMax,
    // node-postgres has no connect timeout by default; fail fast instead of hanging requests.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ...(caCert ? { ssl: { ca: normalizePem(caCert), rejectUnauthorized: true } } : {}),
  });
  return new PrismaClient({ adapter, log: [{ level: 'error', emit: 'stdout' }] });
}

/** Accept PEMs pasted into single-line env var fields with literal `\n` sequences. */
export function normalizePem(pem: string): string {
  return pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
}

/** Cheap connectivity probe used by readiness checks. */
export async function pingDb(db: PrismaClient): Promise<void> {
  await db.$queryRaw`SELECT 1`;
}

export { PrismaClient };
