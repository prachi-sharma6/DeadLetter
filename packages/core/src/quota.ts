import type { Db } from '@deadletter/db';

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export interface QuotaResult {
  allowed: boolean;
  /** Usage after this call (unchanged when not allowed). */
  used: number;
  limit: number;
}

/**
 * Atomically consume `amount` from a project's daily job quota. The check and the increment happen in one
 * `INSERT … ON CONFLICT DO UPDATE … WHERE` statement, so concurrent requests can never push usage past `limit`.
 */
export async function consumeDailyJobQuota(
  db: Db,
  input: { projectId: string; amount: number; limit: number; now?: Date },
): Promise<QuotaResult> {
  const day = utcDay(input.now ?? new Date());
  if (input.amount <= 0)
    return { allowed: true, used: await currentDailyJobUsage(db, input.projectId, day), limit: input.limit };
  if (input.amount > input.limit) {
    return { allowed: false, used: await currentDailyJobUsage(db, input.projectId, day), limit: input.limit };
  }
  const rows = await db.$queryRaw<{ jobsCreated: number }[]>`
    INSERT INTO "UsageCounter" ("projectId", "day", "jobsCreated")
    VALUES (${input.projectId}::uuid, ${day}::date, ${input.amount})
    ON CONFLICT ("projectId", "day") DO UPDATE
      SET "jobsCreated" = "UsageCounter"."jobsCreated" + EXCLUDED."jobsCreated"
      WHERE "UsageCounter"."jobsCreated" + EXCLUDED."jobsCreated" <= ${input.limit}
    RETURNING "jobsCreated"`;
  const row = rows[0];
  if (row) return { allowed: true, used: row.jobsCreated, limit: input.limit };
  return { allowed: false, used: await currentDailyJobUsage(db, input.projectId, day), limit: input.limit };
}

export async function currentDailyJobUsage(db: Db, projectId: string, day: string): Promise<number> {
  const rows = await db.$queryRaw<{ jobsCreated: number }[]>`
    SELECT "jobsCreated" FROM "UsageCounter" WHERE "projectId" = ${projectId}::uuid AND "day" = ${day}::date`;
  return rows[0]?.jobsCreated ?? 0;
}
