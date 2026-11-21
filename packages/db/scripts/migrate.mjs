#!/usr/bin/env node
// Apply pending Prisma migrations (`prisma migrate deploy`).
//   node packages/db/scripts/migrate.mjs           production / development
//   node packages/db/scripts/migrate.mjs --test    refuses unless the database name ends in `_test`
//
// When DATABASE_CA_CERT is set (e.g. Supabase), migrations run over TLS verified against that CA, matching the app's
// runtime connection, so credentials never travel unencrypted.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootEnv = path.resolve(dbDir, '../../.env');
const testMode = process.argv.includes('--test');

if (testMode && !process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(path.resolve(dbDir, '../../.env.test'));
  } catch {
    /* CI provides env vars */
  }
}
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(rootEnv);
  } catch {
    /* production provides env vars */
  }
}

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.error('migrate: DATABASE_URL is not set');
  process.exit(1);
}

let url;
try {
  url = new URL(raw);
} catch {
  console.error('migrate: DATABASE_URL is not a valid URL');
  process.exit(1);
}
const dbName = url.pathname.replace(/^\//, '');
if (testMode && !dbName.endsWith('_test')) {
  console.error(`migrate --test: refusing to migrate non-test database "${dbName}"`);
  process.exit(1);
}

const ca = process.env.DATABASE_CA_CERT;
if (ca) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-db-ca-'));
  const file = path.join(dir, 'ca.crt');
  writeFileSync(file, ca.includes('\\n') ? ca.replace(/\\n/g, '\n') : ca, { mode: 0o600 });
  url.searchParams.set('sslmode', 'require');
  url.searchParams.set('sslrootcert', file);
}

console.log(`migrate: applying migrations to "${dbName}" on ${url.hostname}${ca ? ' (TLS, verified CA)' : ''}`);
// Run Prisma's CLI file directly with this Node binary: no npx, no shell, works the same on Windows and in the slim image.
const prismaCli = createRequire(path.join(dbDir, 'package.json')).resolve('prisma/build/index.js');
const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
  cwd: dbDir,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url.toString() },
});
process.exit(result.status ?? 1);
