import type { PrismaClient } from './generated/client';

/**
 * Empty every application table. Test-only: refuses to run unless the connected database name ends in `_test`, so it
 * can never wipe a development or production database.
 */
export async function truncateAllTables(db: PrismaClient): Promise<void> {
  const [row] = await db.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
  const name = row?.current_database ?? '';
  if (!name.endsWith('_test')) throw new Error(`refusing to truncate non-test database "${name}"`);
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
