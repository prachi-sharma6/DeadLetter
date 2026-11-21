/**
 * Job lifecycle. Every write path checks transitions here, and the database update additionally compares the
 * expected status and version (see packages/core), so a transition is valid only if both agree.
 *
 *   QUEUED ─▶ PROCESSING ─▶ COMPLETED                      (terminal)
 *      │          ├─▶ RETRYING ─▶ PROCESSING …            (automatic retry, policy driven)
 *      │          ├─▶ FAILED          non-retryable error
 *      │          └─▶ DEAD_LETTER     retries exhausted
 *   FAILED / DEAD_LETTER ─▶ RETRYING                       (manual retry)
 *   any non-terminal ─▶ CANCELLED                          (terminal)
 *
 * A COMPLETED job is never retried; it can only be *replayed*, which creates a new job.
 */
export const JOB_STATUSES = [
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'RETRYING',
  'DEAD_LETTER',
  'CANCELLED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  QUEUED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'FAILED', 'RETRYING', 'DEAD_LETTER', 'CANCELLED'],
  RETRYING: ['PROCESSING', 'FAILED', 'DEAD_LETTER', 'CANCELLED'],
  FAILED: ['RETRYING', 'DEAD_LETTER', 'CANCELLED'],
  DEAD_LETTER: ['RETRYING', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const TERMINAL_STATUSES: readonly JobStatus[] = ['COMPLETED', 'CANCELLED'];
/** Failed for good unless someone intervenes. */
export const FAILURE_STATUSES: readonly JobStatus[] = ['FAILED', 'DEAD_LETTER'];
/** Work still pending or running. */
export const ACTIVE_STATUSES: readonly JobStatus[] = ['QUEUED', 'PROCESSING', 'RETRYING'];
/** States from which a manual retry is allowed. */
export const MANUAL_RETRY_FROM: readonly JobStatus[] = ['FAILED', 'DEAD_LETTER'];
/** States from which a replay (new job from the stored payload) is allowed. */
export const REPLAYABLE_STATUSES: readonly JobStatus[] = ['COMPLETED', 'FAILED', 'DEAD_LETTER', 'CANCELLED'];

export const isTerminal = (s: JobStatus) => TERMINAL_STATUSES.includes(s);
export const canTransition = (from: JobStatus, to: JobStatus) => TRANSITIONS[from].includes(to);
export const nextStatuses = (from: JobStatus): readonly JobStatus[] => TRANSITIONS[from];

/** Every status that may legally move to `to`; used to build the `status IN (...)` guard of an update. */
export function allowedPreviousStatuses(to: JobStatus): JobStatus[] {
  return JOB_STATUSES.filter((s) => TRANSITIONS[s].includes(to));
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: JobStatus,
    readonly to: JobStatus,
  ) {
    super(`Invalid job status transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
