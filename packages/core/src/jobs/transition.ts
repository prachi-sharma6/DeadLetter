import type { Db, Job, Prisma } from '@deadletter/db';
import { allowedPreviousStatuses, assertTransition, type JobStatus } from '@deadletter/shared';
import { ConcurrentUpdateError, InvalidStateError, NotFoundError } from '../errors';

export interface TransitionInput {
  jobId: string;
  to: JobStatus;
  /** Statuses the job must currently be in. Defaults to every status that may legally move to `to`. */
  from?: readonly JobStatus[];
  /** If given, the update only applies when the row still has this version (optimistic concurrency). */
  expectedVersion?: number;
  /** Extra columns to set in the same atomic update. */
  data?: Omit<Prisma.JobUpdateManyMutationInput, 'status' | 'version'>;
}

/**
 * Atomically move a job to a new status. A single `UPDATE … WHERE status IN (from) [AND version = expected]` performs
 * the check and the write together, so concurrent callers (two workers, a double-clicked retry, a late report) can
 * never both succeed. Every successful update increments `version`.
 *
 * Throws InvalidStateError when the job is in a status that cannot move to `to`, ConcurrentUpdateError when only the
 * version changed underneath us, and NotFoundError when the job does not exist.
 */
export async function transitionJob(db: Db, input: TransitionInput): Promise<Job> {
  const from = input.from ?? allowedPreviousStatuses(input.to);
  for (const f of from) assertTransition(f, input.to); // programming error if a caller asks for an illegal move

  const result = await db.job.updateMany({
    where: {
      id: input.jobId,
      status: { in: [...from] },
      ...(input.expectedVersion !== undefined ? { version: input.expectedVersion } : {}),
    },
    data: { ...input.data, status: input.to, version: { increment: 1 } },
  });

  if (result.count === 0) {
    const current = await db.job.findUnique({ where: { id: input.jobId }, select: { status: true, version: true } });
    if (!current) throw new NotFoundError('Job');
    if (!from.includes(current.status)) {
      throw new InvalidStateError(`Job is ${current.status} and cannot move to ${input.to}`, {
        status: current.status,
        requested: input.to,
      });
    }
    throw new ConcurrentUpdateError('Job');
  }
  return db.job.findUniqueOrThrow({ where: { id: input.jobId } });
}
