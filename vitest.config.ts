import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Integration tests talk to real Postgres and Redis. Locally they come from .env.test; in CI from the workflow env.
if (existsSync('.env.test')) process.loadEnvFile('.env.test');

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/src/**/*.test.{ts,tsx}'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['{apps,packages}/*/{src,test}/**/*.int.test.ts'],
          environment: 'node',
          env: { NODE_ENV: 'test' },
          globalSetup: ['vitest.integration-setup.ts'],
          // One shared database: files must not run in parallel or one file's cleanup wipes another's data.
          fileParallelism: false,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['{apps,packages}/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.*', '**/main.ts', '**/server.ts', 'apps/web/**'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
