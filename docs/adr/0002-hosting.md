# 0002: Hosting on free tiers

**Context.** Must cost nothing to run. The worker must never sleep because retries are time-based.

**Decision.** Northflank Sandbox (2 always-on services: `api` serving REST + web, and `worker`), Postgres on
Northflank's database add-on (fallback: Supabase Free), Redis Cloud Free (30 MB, 30 connections), Resend for email,
Sentry + UptimeRobot for monitoring, GitHub Actions for CI and nightly backups to Cloudflare R2.

**Rejected.** Render Free (sleeps after 15 min idle), Koyeb Free (forced scale-to-zero), Neon (an always-on worker
exceeds 100 CU-hours/month), Upstash (idle BullMQ polling burns the command quota). Fallback: Oracle Always Free VM.

**Consequences.** No uptime SLA; tight database, Redis and email budgets enforced by quotas and retention. Moving to
paid tiers is configuration only. Free-tier limits must be re-checked before each deployment-related phase.
