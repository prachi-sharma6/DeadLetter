import { errorGroupTitle, normalizeErrorMessage, stackSignature } from '@deadletter/shared';
import { sha256Hex } from './ids';

export interface ErrorIdentity {
  fingerprint: string;
  title: string;
  normalizedMessage: string;
  stackSignature: string;
}

/**
 * Group identity for a failure. Type, normalized message, stack signature, job type and queue all take part, so
 * unrelated errors that merely read alike stay in separate groups.
 */
export function errorIdentity(e: {
  errorType: string;
  message: string;
  stack?: string | null;
  jobType: string;
  queueName: string;
}): ErrorIdentity {
  const normalizedMessage = normalizeErrorMessage(e.message);
  const signature = stackSignature(e.stack);
  const fingerprint = sha256Hex(
    [e.errorType, normalizedMessage, signature, e.jobType, e.queueName].join('\u0001'),
  ).slice(0, 40);
  return {
    fingerprint,
    title: errorGroupTitle(e.errorType, normalizedMessage),
    normalizedMessage,
    stackSignature: signature,
  };
}
