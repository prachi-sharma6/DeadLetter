# Contributing

## Workflow

1. Branch from `main`: `feat/<short-name>`, `fix/<short-name>`, `chore/<short-name>`.
2. Commit with [Conventional Commits](https://www.conventionalcommits.org/) (`feat: …`, `fix: …`, `chore: …`).
   A `commit-msg` hook enforces this.
3. Open a pull request. CI must be green: format, lint, typecheck, unit + integration tests, build, Docker images,
   dependency audit.
4. Squash-merge into `main`. `main` is always deployable.

## Local checks

A `pre-commit` hook runs ESLint and Prettier on staged files. Before pushing, run:

```bash
npm run lint && npm run typecheck && npm test
```

## Rules of thumb

- Validate every external input with Zod at the boundary.
- Never log secrets, API keys, passwords or raw payloads.
- Database migrations are forward-only. Add before you remove: new columns first, destructive changes in a later release.
- Significant design decisions get an ADR in `docs/adr/`.
- New npm packages with install scripts must be approved explicitly (`npm install-scripts approve <pkg>`).
