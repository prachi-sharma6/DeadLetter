/**
 * Expected domain failures. Each carries a stable machine-readable `code` and the HTTP status the API maps it to, so
 * callers never parse messages. Anything that is not a DomainError is a bug and becomes a 500.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) {
    super('NOT_FOUND', 404, `${what} not found`);
  }
}

/** The resource is in a state where the requested change is not allowed (e.g. retrying a completed job). */
export class InvalidStateError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INVALID_STATE', 409, message, details);
  }
}

/** Someone else changed the resource between our read and our write; reload and try again. */
export class ConcurrentUpdateError extends DomainError {
  constructor(what: string) {
    super('CONCURRENT_UPDATE', 409, `${what} was changed by another request; reload and try again`);
  }
}

export class QuotaExceededError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('QUOTA_EXCEEDED', 429, message, details);
  }
}

export class IdempotencyKeyReusedError extends DomainError {
  constructor() {
    super('IDEMPOTENCY_KEY_REUSED', 422, 'This Idempotency-Key was already used with a different request');
  }
}

export class RequestInProgressError extends DomainError {
  constructor() {
    super('REQUEST_IN_PROGRESS', 409, 'A request with this Idempotency-Key is still being processed; retry shortly');
  }
}
