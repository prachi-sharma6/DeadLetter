import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';

export interface DbOptions {
  url: string;
  /** Free-tier Postgres plans allow few connections; keep the per-process pool small. */
  poolMax?: number;
}

export function createDb({ url, poolMax = 5 }: DbOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: url,
    max: poolMax,
    // node-postgres has no connect timeout by default; fail fast instead of hanging requests.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  return new PrismaClient({ adapter, log: [{ level: 'error', emit: 'stdout' }] });
}

/** Cheap connectivity probe used by readiness checks. */
export async function pingDb(db: PrismaClient): Promise<void> {
  await db.$queryRaw`SELECT 1`;
}

export { PrismaClient };
