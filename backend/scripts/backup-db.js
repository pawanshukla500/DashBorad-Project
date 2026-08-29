import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const here = path.dirname(fileURLToPath(import.meta.url));
const backupDir = path.resolve(here, '..', 'backups');
fs.mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(backupDir, `dashboard-${stamp}.dump`);
const args = [
  '--format=custom',
  '--no-owner',
  '--no-privileges',
  '--file', output,
  '--host', process.env.PG_HOST,
  '--port', process.env.PG_PORT || '5432',
  '--username', process.env.PG_USER,
  process.env.PG_DATABASE,
];

const result = spawnSync('pg_dump', args, {
  stdio: 'inherit',
  env: { ...process.env, PGPASSWORD: process.env.PG_PASSWORD || '' },
});

if (result.error) {
  console.error('Database backup failed:', result.error.message);
  console.error('Install PostgreSQL client tools and make sure pg_dump is available on PATH.');
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status || 1);

console.log(`Database backup created: ${output}`);
