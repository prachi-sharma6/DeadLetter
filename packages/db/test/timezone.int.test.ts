import { afterAll, describe, expect, it } from 'vitest';
import { assertUtcSession, createDb } from '../src';

// Regression test: with a non-UTC Postgres server (e.g. a developer machine in Asia/Calcutta), timestamps written
// through Prisma's pg adapter were shifted by the server's offset, so "is this due yet?" comparisons broke.
const db = createDb({ url: process.env.DATABASE_URL!, poolMax: 3 });
afterAll(() => db.$disconnect());

describe('timestamps', () => {
  it('runs every pooled session in UTC (database default set by migration)', async () => {
    const rows = await Promise.all(
      Array.from({ length: 3 }, () => db.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`),
    );
    for (const [r] of rows) expect(r?.tz).toBe('UTC');
  });

  it('stores the exact instant and compares correctly with now()', async () => {
    const future = new Date(Date.now() + 60 * 60_000);
    const msg = await db.outboxMessage.create({
      data: { topic: 'tz', payload: {}, dedupeKey: `tz.${Date.now()}`, availableAt: future },
    });
    const [row] = await db.$queryRaw<{ isFuture: boolean; epochMs: number }[]>`
      SELECT "availableAt" > now() AS "isFuture", (extract(epoch FROM "availableAt") * 1000)::float8 AS "epochMs"
      FROM "OutboxMessage" WHERE id = ${msg.id}`;
    expect(row?.isFuture).toBe(true);
    expect(Math.round(row!.epochMs)).toBe(future.getTime());
    await db.outboxMessage.delete({ where: { id: msg.id } });
  });
});

describe('assertUtcSession', () => {
  it('passes on a UTC session and refuses a non-UTC one', async () => {
    await expect(assertUtcSession(db)).resolves.toBeUndefined();
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL TIME ZONE 'Asia/Kolkata'`;
        await assertUtcSession(tx);
      }),
    ).rejects.toThrow(/expected UTC/);
  });
});
