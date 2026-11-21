# DeadLetter: production plan

Status: **approved**. Phases 0–2 done and deployed (https://deadletter.onrender.com); Phase 3 next.
Date: 2026-11-21. Free-tier facts below were checked on this date and change often; each phase that depends on one re-checks it.

---

## 1. What "production grade" means here

| Area        | Target                                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Correctness | No lost jobs, no duplicate scheduling, valid state transitions only, history never rewritten                                     |
| Security    | OWASP ASVS L1 basics: verified email, hashed secrets, tenant isolation tested, rate limits, audit log, encrypted secrets at rest |
| Reliability | Survives worker/API restarts and Redis loss; graceful shutdown; nightly off-site DB backups with a tested restore                |
| Operability | Error tracking, structured logs, health checks, uptime alerts, runbooks                                                          |
| Delivery    | Git + PR workflow, CI on every push (typecheck, lint, unit, integration, e2e), one-command deploys, migrations in the pipeline   |
| Product     | Real users can sign up, invite teammates, instrument an app in under 10 minutes, and recover a failed job from the UI            |

**Honest limit:** free hosting has **no uptime SLA**, small databases, and connection caps. The code and practices can be production grade; the infrastructure is hobby grade until you pay for it. The plan keeps the app small enough to fit free tiers, and moving to paid tiers later is a config change, not a rewrite.

---

## 2. What is wrong with the current build (why we restart)

The prototype proved the feature set but has structural problems that are cheaper to fix in a clean rebuild than to patch:

1. **No git, no CI.** Nothing is versioned and nothing runs automatically.
2. **One BullMQ queue and worker per tenant queue.** Every new customer queue adds Redis connections. The free Redis tier allows **30 connections**, so this breaks within a few customers.
3. **Dual writes without an outbox.** A job is committed to Postgres and then pushed to Redis; a crash in between relies on a polling reconciler.
4. **Production runs TypeScript through `tsx`.** No compiled build, no reproducible artifact.
5. **Rate limits live in process memory.** They reset on restart and don't work across instances.
6. **Secrets.** Webhook signing secrets are stored in plaintext. The SSRF guard resolves DNS and then fetches separately, which is open to DNS rebinding. Webhook responses aren't size-capped.
7. **Recovery requires the customer to expose a public webhook.** Most apps run jobs behind a firewall (BullMQ, cron, serverless), so retry/replay won't work for them.
8. **No teams.** No email verification, no invites, no organizations, no session management.
9. **Unbounded growth.** Attempts, events and audit rows are never trimmed, and analytics scan raw tables. Both fail on a 0.5–1 GB free database.
10. **No per-project quotas.** One noisy client can fill the free database for everyone.
11. **Background schedulers run in every worker.** Alert evaluation, reconciliation and retention would duplicate work with more than one worker.
12. **Frontend.** A single 900 KB bundle, `any` types throughout, and auth tied to a same-origin cookie, which breaks once the web app and API sit on different hosts.

**Decision D1 (recommended):** start a new git repo with the same stack, a fresh architecture and a fresh schema. Copy over only small modules that pass review: the backoff/jitter math, redaction, error normalisation, Zod schemas, and their unit tests. Everything else is rewritten to the new design.

---

## 3. Target architecture

```
                 ┌──────────── one origin: https://app.<domain> ────────────┐
 Browser ──────▶ │ api service: Express REST + Socket.IO + static SPA files │
                 └──────┬──────────────────────┬───────────────────────────┘
 Customer app ─ SDK ───▶│ /v1 (API key)        │ publish/subscribe
 Customer agent ◀── pull commands (long-poll) ─┤
                        ▼                      ▼
                 PostgreSQL (truth)       Redis (queue + pubsub + rate limits)
                        ▲                      │
                        └─────── worker service (BullMQ, 1 shared queue) ──▶ customer webhook (optional)
```

Key design decisions:

- **Postgres is the single source of truth.** Redis holds only transient state that can be rebuilt.
- **Transactional outbox.** Every state change that needs queue work writes an `outbox` row in the same transaction. A dispatcher moves outbox rows into BullMQ. Nothing is lost if Redis is down.
- **One shared BullMQ queue** (`dl:attempts`) plus one `dl:scheduler` queue for repeatable maintenance jobs. Per-project fairness and concurrency are enforced in application code with Redis counters. Total Redis connections: about 6.
- **Leader-only schedulers.** Alert evaluation, reconciliation, rollups and retention run as BullMQ repeatable jobs, so exactly one worker runs each tick.
- **Two execution modes for recovery:**
  1. **Push.** DeadLetter POSTs to the customer's signed webhook. HMAC signature, timestamp, idempotency key, SSRF-safe pinned-IP fetch, 1 MB response cap.
  2. **Pull (agent).** The SDK long-polls `GET /v1/commands` for retry/replay commands and runs them inside the customer's own process. This works behind firewalls and is the default for BullMQ users.
- **SDK adapters.** `@deadletter/sdk` gets `instrumentBullMQ(queue)`, which reports job events automatically with no manual start/fail calls. A generic `track()` wrapper covers everything else.
- **Same-origin web app.** The API service serves the built SPA, so cookies stay first-party and no CORS setup is needed. Socket.IO authenticates with a short-lived token from `/api/realtime/token`, which also works if the web app is moved to a CDN later.
- **Rollups for analytics.** A per-minute `job_stats` table is updated incrementally. Dashboards read rollups and never scan raw jobs.
- **Retention and quotas are first-class.** Per-plan limits (jobs/day, payload size, retention days) are enforced at ingestion.

**Decision D3 (recommended):** keep **BullMQ + Redis** as the original spec asks, with the outbox. Alternative: a Postgres-only queue (pg-boss), which drops Redis entirely. It is simpler on free tiers but deviates from the spec.

---

## 4. Free deployment stack (recommended)

> **Update 2026-11-21:** Northflank turned out to require a card for verification, and we have none. The current
> deployment is **Render Free (API + web + in-process worker) + Supabase Free + Redis Cloud Free + cron-job.org**; see
> [ADR 0009](docs/adr/0009-no-card-hosting.md) and [docs/deploy/render.md](docs/deploy/render.md). The table below is
> the target once a card is available.

| Need                  | Service                                                           | Free allowance (checked 2026-11-21)                                                            | Notes                                                                                              |
| --------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| API + web (always on) | **Northflank Sandbox** service #1                                 | 2 always-on services, 2 jobs, 1 database, no card reported                                     | Built from a Dockerfile on GitHub push. No local Docker needed                                     |
| Worker (always on)    | **Northflank Sandbox** service #2                                 | same                                                                                           | Must not sleep: retries are time-based                                                             |
| PostgreSQL            | **Northflank DB addon** (verify size), fallback **Supabase Free** | Supabase: 500 MB, pauses after 1 week of _inactivity_ (an always-on worker counts as activity) | **Not Neon:** an always-on worker stops it scaling to zero and would exceed its 100 CU-hours/month |
| Redis                 | **Redis Cloud Free**                                              | 30 MB, 30 connections, 1 database                                                              | **Not Upstash:** idle BullMQ polling burns its 500K commands/month                                 |
| Email                 | **Resend Free**                                                   | 100/day, 3,000/month                                                                           | Sending to real users needs a verified domain (see D4)                                             |
| Error tracking        | Sentry Developer (free)                                           | limited events/month                                                                           | API, worker and browser                                                                            |
| Uptime checks         | UptimeRobot or Better Stack free                                  | 5-minute checks                                                                                | Pings `/api/health`                                                                                |
| Backups               | GitHub Actions nightly `pg_dump` → **Cloudflare R2** free tier    | R2 includes free storage                                                                       | Encrypted with `age` before upload                                                                 |
| CI/CD                 | GitHub Actions                                                    | unlimited minutes on public repos                                                              | Postgres + Redis as job service containers                                                         |
| SDK distribution      | npm (public package)                                              | free                                                                                           |                                                                                                    |

**Rejected or fallback options:**

- **Render Free:** web services sleep after 15 minutes without traffic, it isn't clear a worker is free, and Render discourages keep-alive pings. Fine for a demo, not for the worker.
- **Koyeb Free:** forced scale-to-zero after 1 hour idle, 0.1 vCPU.
- **Oracle Always Free VM (fallback, Decision D2):** always-on and generous even after the reported June 2026 cut to 2 OCPU / 12 GB. Needs a credit card for verification, and we'd run TLS, process supervision and updates ourselves.

---

## 5. Phases

Size key: **S** ≈ 1–2 working sessions, **M** ≈ 3–5, **L** ≈ 6+. Each phase ends with its exit criteria met **in CI** and, from Phase 1 on, **deployed**.

### Phase 0: Foundations (S)

- New git repo on GitHub with branch protection on `main`, PR template, `CODEOWNERS`, Conventional Commits.
- Node **24 LTS** pinned (`.nvmrc`, `engines`); npm workspaces; strict TypeScript.
- Real builds: `tsup` compiles API/worker/SDK to JS, Vite builds the web app. Production never runs `tsx`.
- ESLint + Prettier + `lint-staged`. Zod-validated config: the app refuses to boot with missing or invalid env.
- GitHub Actions CI: install → typecheck → lint → unit → integration (Postgres + Redis service containers) → build. Dependabot + `npm audit` gate.
- Architecture decision records (`docs/adr/`) for D1–D7.
- **Exit:** a PR runs green CI, and a hello-world API is deployed on Northflank with `/health`.

### Phase 1: Data model and core domain (M)

- Prisma schema v2: `Organization`, `Membership(role)`, `Invite`, `Project`, `ApiKey(scopes, hash, prefix)`, `Job`, `JobPayload`, `JobAttempt` (immutable), `JobEvent`, `RetryPolicy` + revisions, `RecoveryOperation`, `Outbox`, `ErrorGroup`, `JobStatsMinute` (rollup), `AlertRule`, `AlertDelivery`, `Notification`, `WorkerHeartbeat`, `AuditLog`, `Session`, `EmailToken`.
- Status machine and transition guard as one module, used by every write path. Compare-and-swap updates with a `version` column.
- Outbox table + dispatcher, idempotency key table, quotas table.
- Indexes designed from the actual query list. Migration policy: forward-only, additive first, destructive changes in a later release.
- Ported and reviewed: backoff/jitter math, policy precedence, redaction, error normalisation, with unit tests.
- **Exit:** domain unit tests at 90%+ coverage on the state machine and retry engine; migrations run in CI and on deploy.

### Phase 2: Identity and tenancy (M)

- Sign up with **email verification**, login, logout, password reset, change password.
- Server-side `Session` table: list and revoke sessions, 30-day sliding expiry, rotation on privilege change.
- Organizations with roles (owner/admin/member/viewer), invites by email, member removal, ownership transfer.
- Optional TOTP 2FA (stretch).
- CSRF: SameSite=Lax cookie + `Origin` check + custom-header requirement. Redis-backed rate limits on auth, console and API.
- Account deletion and data export (GDPR-style basics).
- **Exit:** an automated cross-tenant isolation test suite (every route × another org's ids → 404).

### Phase 3: Ingestion API and SDK v1 (M)

- Versioned `/v1` API: single and **batch** event endpoint, idempotency keys, consistent error envelope, request IDs, per-key and per-project rate limits, per-plan quotas, payload caps.
- OpenAPI generated from the Zod schemas (no hand-written spec drift), served via Swagger UI.
- `@deadletter/sdk` v1: an in-memory batching buffer flushed every 1 s, timeouts, retries with backoff, never logs keys or payloads, **`instrumentBullMQ()`** adapter, `track()` wrapper, and pull-agent mode (`dl.agent.start({ handlers })`).
- SDK published to npm with semantic versioning and a changelog.
- **Exit:** an example app in `examples/bullmq-app` reports jobs end to end against the deployed API.

### Phase 4: Execution and recovery engine (L)

- Worker: shared queue, per-project concurrency, graceful drain, stalled-job handling, heartbeats in Redis.
- Retry policies (CRUD + revisions + precedence), exponential/linear/fixed backoff, jitter, retryable and non-retryable error lists, bounded attempts.
- Manual retry, bulk retry by ids or filter (async background operation with progress), cancel, cancel pending retry.
- Replay as a new job: completed-job guard with explicit acknowledgement, payload override with shape check, de-duplication.
- Push executor: encrypted webhook secrets (AES-256-GCM with an app key), DNS-pinned SSRF-safe fetch, response cap, timeout.
- Pull executor: command queue per project, lease and acknowledgement, timeouts return the command.
- Leader-only repeatable jobs: outbox dispatch, reconciliation, retention, rollups, alert evaluation.
- **Exit:** queue test suite green in CI, covering crash mid-job, Redis flush, double-click retry, concurrent workers, worker restart with delayed retries, and pull-agent disconnect.

### Phase 5: Dashboard (L)

- Design system (Tailwind tokens, accessible primitives), route-based code splitting (initial bundle under 250 KB gzipped), typed API client generated from OpenAPI.
- Pages: auth flows, onboarding checklist, org/project switcher, dashboard, all jobs, failed jobs, job detail (timeline, attempts, compare, payload viewer), error groups, queues, workers, retry policies, alerts, analytics, API keys, members/invites, audit log, settings, SDK docs, 404.
- Realtime via token-auth Socket.IO with refetch-on-reconnect.
- Accessibility (axe checks in CI), responsive layouts, dark/light theme.
- **Exit:** Playwright suite covering the critical paths runs in CI against a deployed preview.

### Phase 6: Observability features (M)

- Error grouping (fingerprint, normalisation, trends), analytics from rollups with documented formulas and CSV export.
- Alerts: rule types, cooldown, de-duplication, delivery log, in-app + email (Resend) + Slack (incoming webhook per org, stored encrypted).
- Audit log with filters. Optional AI analysis (off by default, redacted input, facts vs hypotheses).
- **Exit:** a 100k-job synthetic dataset keeps dashboard queries under 300 ms p95 on the free database.

### Phase 7: Hardening (M)

- Security pass: dependency audit, header/CSP review, secrets scan (gitleaks in CI), authz test matrix, rate-limit tests, input fuzzing on ingestion.
- Load test with k6 at the free-tier target (e.g. 50 events/s sustained); tune pool sizes and batch sizes.
- Chaos checks: kill the worker mid-job, restart Redis, restart Postgres; verify no loss.
- Backups: nightly encrypted `pg_dump` to R2 and a **restore drill** documented and timed.
- Retention jobs verified against the database size budget.
- **Exit:** a written threat model, a passing restore drill, and load-test results recorded in `docs/`.

### Phase 8: Launch on free infrastructure (S)

- Northflank: `api` and `worker` services from GitHub, health checks, env secrets, deploy on merge to `main`, `prisma migrate deploy` as a pre-deploy job.
- Redis Cloud, Postgres, Resend (domain DNS: SPF/DKIM), Sentry DSNs, UptimeRobot monitor, R2 bucket + backup workflow.
- Runbooks: deploy, rollback, rotate secrets, restore backup, Redis outage, database full.
- Status page (free Better Stack or UptimeRobot page), public docs site, landing page.
- **Exit:** a stranger can sign up, verify email, instrument the example app, see a failure and recover it, on the public URL.

---

## 6. Free-tier capacity budget (initial plan limits)

Rough figures, to be confirmed by the Phase 7 load test.

| Resource                     | Budget                                             | Enforced by                                                                                        |
| ---------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Postgres 0.5–1 GB            | ~200k retained jobs total                          | 7-day retention on the free plan, payload cap 32 KB stored (larger payloads truncated with a hash) |
| Redis 30 MB / 30 connections | ~6 connections used, only job ids in Redis         | `removeOnComplete`/`removeOnFail` limits, shared queue                                             |
| Email 100/day                | alerts + auth emails                               | per-org alert email cap, digest mode                                                               |
| Per project                  | 5k jobs/day, 3 projects per org, 5 members per org | quota checks at ingestion                                                                          |

---

## 7. Decisions needed from you

| #   | Decision                                             | Recommended                                                                           |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| D1  | Rebuild in a new repo vs keep evolving the prototype | **Rebuild**, porting vetted pure modules                                              |
| D2  | Hosting                                              | **Northflank Sandbox**; fallback Oracle Always Free VM                                |
| D3  | Queue backend                                        | **BullMQ + Redis** with outbox (per spec); alternative pg-boss                        |
| D4  | Buy a domain (~$10/year)                             | **Yes.** Without one, verification/reset/alert emails can only go to your own address |
| D5  | Public or private GitHub repo                        | **Public** (free CI minutes, portfolio value); private also works within free minutes |
| D6  | Recovery modes in v1                                 | **Both** push (webhook) and pull (agent)                                              |
| D7  | Teams/organizations in v1                            | **Yes**                                                                               |

Once these are confirmed, implementation starts at Phase 0.

---

## Sources (free-tier checks)

- Render free tier: <https://render.com/docs/free>
- Neon limits: <https://neon.com/faqs/free-plan-limits-and-quotas>
- Supabase pausing: <https://supabase.com/docs/guides/platform/free-project-pausing.md>, pricing <https://supabase.com/pricing>
- Redis Cloud Essentials plans: <https://redis.io/docs/latest/operate/rc/subscriptions/view-essentials-subscription/essentials-plan-details/>
- Upstash pricing / BullMQ note: <https://upstash.com/pricing/redis>, <https://upstash.com/docs/redis/integrations/bullmq.md>
- Koyeb scale-to-zero: <https://www.koyeb.com/docs/run-and-scale/scale-to-zero>
- Northflank pricing: <https://northflank.com/pricing>
- Oracle Free Tier: <https://docs.oracle.com/iaas/Content/FreeTier/freetier.htm>, reported 2026 cut <https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/>
- Aiven free tier: <https://aiven.io/free-tier>
- Resend limits: <https://resend.com/docs/knowledge-base/resend-sending-limits>
