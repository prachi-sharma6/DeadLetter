# 0003: BullMQ + Redis with a transactional outbox

**Context.** The spec asks for Redis + BullMQ. Writing to Postgres and Redis separately can lose work on a crash.

**Decision.** Postgres is the source of truth. State changes that need queue work insert an `outbox` row in the same
transaction; a dispatcher moves rows into a single shared BullMQ queue. Per-project fairness and concurrency are
enforced in application code. Maintenance tasks run as BullMQ repeatable jobs so exactly one worker runs each tick.

**Alternative.** A Postgres-only queue (pg-boss) would remove Redis entirely; kept as a fallback if Redis limits bite.

**Consequences.** About 6 Redis connections in total regardless of tenant count; Redis can be flushed and rebuilt from
Postgres.
