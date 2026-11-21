# DeadLetter

Monitor, inspect, debug, retry and recover failed background jobs.

> **Status: Phase 0 (foundations).** The repository has the tooling, CI, builds and deployable skeletons. Product
> features land phase by phase; see [PLAN.md](PLAN.md).

## Repository layout

| Path               | What                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| `apps/api`         | Express API; in production it also serves the built web app (one origin) |
| `apps/worker`      | Background worker (queue processing arrives in Phase 4)                  |
| `apps/web`         | React + Vite + Tailwind dashboard                                        |
| `packages/shared`  | Pure TypeScript shared by every app (validation, domain logic)           |
| `packages/runtime` | Node helpers: logging, Redis, graceful shutdown, timeouts                |
| `packages/db`      | Prisma schema, migrations and client                                     |
| `docs/adr`         | Architecture decision records                                            |

## Requirements

- Node.js 24 LTS (`.nvmrc`); 26 also works locally
- PostgreSQL 14+ and Redis 7+ running locally (on Windows, [Memurai](https://www.memurai.com/) provides Redis)
- No Docker needed for development. The `Dockerfile` is only used by CI and the hosting platform.

## Getting started

```bash
npm install
cp .env.example .env         # set DATABASE_URL / REDIS_URL
cp .env.example .env.test    # point at a separate test database and Redis db 1
npm run db:generate
npm run dev                  # API :4000, worker, web :5173
```

Open <http://localhost:5173>. The page shows live database, Redis and worker status from `/api/health`.

## Scripts

| Command                                  | Does                                                        |
| ---------------------------------------- | ----------------------------------------------------------- |
| `npm run dev`                            | API + worker + web with reload                              |
| `npm run build`                          | Compile API/worker (tsup) and web (Vite) to `dist/`         |
| `npm run start:api` / `start:worker`     | Run the compiled output (what production runs)              |
| `npm run lint` / `typecheck` / `format`  | ESLint (type-aware), `tsc -b`, Prettier                     |
| `npm test`                               | Unit + integration tests                                    |
| `npm run test:unit` / `test:integration` | Integration tests need Postgres + Redis from `.env.test`    |
| `npm run audit:prod`                     | Fail on high-severity advisories in production dependencies |

## Health endpoints

- `GET /api/health/live`: process is up (no dependency checks; used for restarts)
- `GET /api/health`: Postgres + Redis reachable, live worker count, build version; `503` when degraded

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).
