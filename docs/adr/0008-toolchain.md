# 0008: Toolchain and runtime choices

- **Node 24 LTS** in CI and production (`.nvmrc`); local development also works on 26.
- **npm workspaces**; install scripts are an explicit allowlist (`allowScripts` in `package.json`).
- **TypeScript 5.9**, strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`; `tsc -b` over project references.
- **Express 5** (native async error handling), **Zod 4** for all boundary validation, **Pino** structured logs.
- **Prisma 7** with the `prisma-client` generator (no native query engine) and the `@prisma/adapter-pg` driver adapter. The client is generated into `packages/db/src/generated` (git-ignored); the connection URL lives in `packages/db/prisma.config.ts`. Chosen over 6.x because 6.x pulls dependencies with high-severity advisories and its native engine DLL causes file locks on Windows.
- **Security override:** Prisma pins `effect@3.20.0` (ReDoS advisory GHSA-7589-6fvf-x4pw). Root `overrides` forces `effect@3.22.5` (same major). Remove the override once Prisma ships a patched pin.
- **tsup** compiles API and worker; workspace packages are bundled, npm packages stay external. Production never runs `tsx`.
- **React 19 + Vite 7 + Tailwind 4** for the web app, served by the API from the same origin.
- **ESLint 10** (type-aware), **Prettier**, **husky + lint-staged + commitlint**.
- **Vitest 3**: `unit` project (no services) and `integration` project (real Postgres + Redis).
