import { describe, expect, it } from 'vitest';
import {
  JOB_STATUSES,
  InvalidTransitionError,
  allowedPreviousStatuses,
  assertTransition,
  canTransition,
  isTerminal,
  nextStatuses,
  type JobStatus,
} from './status';

// The full transition matrix, written out independently of the implementation.
const EXPECTED: Record<JobStatus, JobStatus[]> = {
  QUEUED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'FAILED', 'RETRYING', 'DEAD_LETTER', 'CANCELLED'],
  RETRYING: ['PROCESSING', 'FAILED', 'DEAD_LETTER', 'CANCELLED'],
  FAILED: ['RETRYING', 'DEAD_LETTER', 'CANCELLED'],
  DEAD_LETTER: ['RETRYING', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

describe('job state machine', () => {
  it.each(JOB_STATUSES.flatMap((from) => JOB_STATUSES.map((to) => [from, to] as const)))(
    '%s -> %s matches the documented matrix',
    (from, to) => {
      expect(canTransition(from, to)).toBe(EXPECTED[from].includes(to));
    },
  );

  it('never lets a completed job move again (retry must go through replay)', () => {
    expect(nextStatuses('COMPLETED')).toEqual([]);
    expect(() => assertTransition('COMPLETED', 'RETRYING')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('COMPLETED', 'QUEUED')).toThrow(/COMPLETED -> QUEUED/);
  });

  it('has no self-transitions', () => {
    for (const s of JOB_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it('marks only COMPLETED and CANCELLED as terminal', () => {
    expect(JOB_STATUSES.filter(isTerminal)).toEqual(['COMPLETED', 'CANCELLED']);
  });

  it('every non-terminal status can be cancelled', () => {
    for (const s of JOB_STATUSES.filter((x) => !isTerminal(x))) expect(canTransition(s, 'CANCELLED')).toBe(true);
  });

  it('computes the legal previous statuses for update guards', () => {
    expect(allowedPreviousStatuses('PROCESSING').sort()).toEqual(['QUEUED', 'RETRYING']);
    expect(allowedPreviousStatuses('RETRYING').sort()).toEqual(['DEAD_LETTER', 'FAILED', 'PROCESSING']);
    expect(allowedPreviousStatuses('QUEUED')).toEqual([]);
  });

  it('assertTransition passes for legal moves', () => {
    expect(() => assertTransition('QUEUED', 'PROCESSING')).not.toThrow();
  });
});
