import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads .env files. Locally we load the repo's .env; CI and production set real env vars.
if (!process.env.DATABASE_URL && existsSync('../../.env')) process.loadEnvFile('../../.env');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Not required for `prisma generate`, so builds work without a database; required for migrate commands.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
