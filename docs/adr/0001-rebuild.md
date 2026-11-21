# 0001: Rebuild in a new repository

**Context.** The prototype proved the feature set but has structural problems: per-tenant BullMQ queues (Redis
connection explosion on a 30-connection free tier), dual writes without an outbox, `tsx` in production, in-memory
rate limits, plaintext webhook secrets, no tenancy model, no CI and no git history.

**Decision.** Start a fresh repository with the same stack and a new architecture and schema. Port only pure modules
after review (backoff/jitter math, policy precedence, redaction, error normalisation, Zod schemas) together with their
tests. The prototype stays locally in `_prototype/` (git-ignored) for reference.

**Consequences.** Some rework of features that already existed; in exchange the foundations (tenancy, outbox, shared
queue, quotas) are designed in rather than retrofitted.
