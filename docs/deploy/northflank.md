# Deploying on free tiers (Northflank + Redis Cloud)

> **Not the current setup.** Northflank requires a card for account verification. The current no-card deployment is
> [render.md](render.md) ([ADR 0009](../adr/0009-no-card-hosting.md)). Use this guide only if a card becomes available.

Runbook for the first deploy and for rebuilding the environment from scratch. Decision record: [ADR 0002](../adr/0002-hosting.md).

**Golden rule for secrets:** paste connection strings and passwords **only into the Northflank UI** (secret group),
never into chat, issues, commits or screenshots.

## What you end up with

| Piece      | Where                         | Free allowance                     |
| ---------- | ----------------------------- | ---------------------------------- |
| `api`      | Northflank service (public)   | 1 of 2 Sandbox services, always on |
| `worker`   | Northflank service (no ports) | 2 of 2 Sandbox services, always on |
| PostgreSQL | Northflank add-on             | the Sandbox's 1 database           |
| Redis      | Redis Cloud "Free" database   | 30 MB, 30 connections              |

Pick regions on the **same continent** for Northflank and Redis Cloud: every API request talks to both.

---

## 1. Redis Cloud (about 5 minutes)

1. Go to <https://redis.io/try-free/> and sign up (Google/GitHub sign-in is fine).
2. Create a database: plan **Free** (30 MB). Choose the cloud region closest to the Northflank region you will use.
3. Open the database. Note the **Public endpoint** (`host:port`) and the **default user password** (Security section).
4. Build the URL (you will paste it into Northflank in step 2.4, nowhere else):
   - `redis://default:<PASSWORD>@<HOST>:<PORT>`
   - If the database page offers **TLS** for your plan, enable it and use `rediss://` instead.

## 2. Northflank

### 2.1 Account and GitHub

1. Sign up at <https://northflank.com> with **GitHub**.
2. When asked to install the Northflank GitHub app, grant access to **only** the `DeadLetter` repository.

### 2.2 Project

Create a project named `deadletter`. Choose the region closest to you (and to your Redis Cloud region).

### 2.3 PostgreSQL add-on

1. In the project: **Create new → Addon → PostgreSQL**. Name `deadletter-db`, latest version, smallest free plan.
2. Wait until it is running.

> If the Sandbox does not offer PostgreSQL, use Supabase Free instead (create a project, copy the **Session pooler**
> connection string) and set it as `DATABASE_URL` in the secret group below.

### 2.4 Secret group (shared env for both services)

**Create new → Secret group**, name `deadletter-env`, type **Runtime**. Add:

| Key                 | Value                                    |
| ------------------- | ---------------------------------------- |
| `NODE_ENV`          | `production`                             |
| `LOG_LEVEL`         | `info`                                   |
| `TRUST_PROXY`       | `1`                                      |
| `DATABASE_POOL_MAX` | `3`                                      |
| `REDIS_URL`         | the URL from step 1.4                    |
| `APP_ORIGIN`        | `https://example.invalid` (fixed in 2.7) |

Then, in the same secret group, **link the `deadletter-db` addon** and expose its connection string (`POSTGRES_URI`)
under the alias **`DATABASE_URL`**.

### 2.5 Service `api`

**Create new → Service → Combined service** (build + deploy):

- Repository `DeadLetter`, branch `main`, **auto-deploy on push: on**
- Build type **Dockerfile**: Dockerfile `/Dockerfile`, build context `/`, **target stage `api`**
- Resources: the smallest free compute plan
- Networking: port **8080**, protocol **HTTP**, **public**
- Health checks:
  - Liveness: HTTP `GET /api/health/live` on port 8080
  - Readiness: HTTP `GET /api/health` on port 8080
- Environment: attach the `deadletter-env` secret group

### 2.6 Service `worker`

**Create new → Service → Combined service**:

- Same repository and branch, auto-deploy on
- Dockerfile `/Dockerfile`, context `/`, **target stage `worker`**
- Smallest free compute plan, **no ports**
- Environment: attach `deadletter-env`

### 2.7 Point APP_ORIGIN at the real URL

1. Open the `api` service; copy its public URL (looks like `https://p01--api--xxxx.code.run`).
2. In `deadletter-env`, set `APP_ORIGIN` to that URL (no trailing slash). Both services restart.

## 3. Verify

- `https://<api-url>/api/health` returns `"status":"ok"`, both checks `ok: true`, and `"workers": 1`.
- `https://<api-url>/` shows the DeadLetter status page.

## Troubleshooting

| Symptom                                      | Fix                                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Service crashes with `Invalid environment`   | The log lists the missing/invalid variable names; fix them in `deadletter-env`.                          |
| `redis: ok: false`                           | Wrong password/host in `REDIS_URL`, or `rediss://` used without TLS enabled (or vice versa).             |
| `database: ok: false`, TLS/certificate error | The addon's TLS certificate is not trusted by default; see the note in ADR 0008 and report the log line. |
| Build fails at `npm ci`                      | Check the build log; the lockfile must be committed and in sync.                                         |
| `workers: 0`                                 | The `worker` service is not running or cannot reach Redis; check its logs.                               |
