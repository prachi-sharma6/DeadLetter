import type { Db, Prisma } from '@deadletter/db';
import { redactValue } from '@deadletter/shared';

/** Who performed an action, carried from the HTTP layer into every service call. */
export interface Actor {
  userId: string;
  /** `user:<id>` or `apikey:<prefix>`; stored on audit rows and job events. */
  label: string;
  requestId?: string;
  ip?: string;
}

export const userActor = (userId: string, extra: { requestId?: string; ip?: string } = {}): Actor => ({
  userId,
  label: `user:${userId}`,
  ...extra,
});

export interface AuditEntry {
  action: string;
  orgId?: string | null;
  projectId?: string | null;
  targetType?: string;
  targetId?: string;
  result?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  metadata?: Record<string, unknown>;
}

/**
 * Record a security-relevant action. Metadata is redacted (secrets, tokens, passwords never reach the table). Pass the
 * surrounding transaction so the audit row commits or rolls back with the change it describes.
 */
export async function writeAudit(
  db: Db,
  actor: Actor | { label: string; requestId?: string; ip?: string },
  entry: AuditEntry,
): Promise<void> {
  await db.auditLog.create({
    data: {
      orgId: entry.orgId ?? null,
      projectId: entry.projectId ?? null,
      actor: actor.label,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      result: entry.result ?? 'SUCCESS',
      metadata: entry.metadata ? (redactValue(entry.metadata) as Prisma.InputJsonValue) : undefined,
      requestId: actor.requestId,
      ip: actor.ip,
    },
  });
}
