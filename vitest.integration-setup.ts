import { spawnSync } from 'node:child_process';

/**
 * Global setup for the integration project: bring the test database schema up to date once per run. The migrate
 * script refuses any database whose name does not end in `_test`, so this can never touch real data.
 */
export default function setup() {
  const r = spawnSync(process.execPath, ['packages/db/scripts/migrate.mjs', '--test'], {
    stdio: 'inherit',
    env: process.env,
  });
  if (r.status !== 0) throw new Error('test database migration failed');
}
