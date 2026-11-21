# 0009: No-card hosting (Render + Supabase + Redis Cloud)

Status: accepted. Supersedes the compute part of [0002](0002-hosting.md) until a card is available.

**Context.** Northflank requires a credit/debit card to verify the account before creating anything, even on the free
Sandbox. We have no card. Every free always-on host checked (Northflank, Oracle, Google Cloud) needs one; the no-card
hosts (Render, Koyeb) put idle services to sleep, and Render's background workers are not free.

**Decision.**

- **Compute:** one Render Free web service (`render.yaml`, region Singapore) running the API, the web app and the worker
  in one process (`RUN_WORKER=true`, Dockerfile stage `all`, which must stay the last stage because Render cannot select
  a build target).
- **Database:** Supabase Free (500 MB) through its Session pooler, with TLS verified against Supabase's CA certificate
  (`DATABASE_CA_CERT`). Not Neon: an always-active worker would exhaust its 100 CU-hours/month.
- **Redis:** Redis Cloud Free (30 MB, 30 connections).
- **Keep-awake and clock:** cron-job.org calls `GET /api/health` every minute. That counts as inbound traffic, so Render
  does not spin the service down (750 free hours/month covers one service all month), and it keeps Supabase active.
- Regions: Render Singapore, Supabase and Redis Cloud in Singapore (`ap-southeast-1`) for low latency to each other and
  to users in India.

**Consequences.**

- Render may still restart the free service at any time, and frowns on keep-alive pings. Correctness must therefore
  never depend on the process staying up: Postgres is the source of truth, due work is re-derived on startup, and late
  is acceptable; lost is not. From Phase 4, time-based work also runs from an authenticated tick endpoint called by the
  same cron.
- Free instance is 0.1 CPU / 512 MB: keep memory low (no in-process caches of payloads; small DB pool).
- Database migrations cannot run in a separate job on the free plan; from Phase 1 they run at container start before
  the server listens.
- Moving to an always-on host later (Northflank with a card, or any paid plan) needs no code change: run the `api` and
  `worker` stages as separate services and drop the cron.
