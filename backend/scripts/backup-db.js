import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { resolvePgConfig } from '../db/index.js';

dotenv.config();

const here = path.dirname(fileURLToPath(import.meta.url));
const backupDir = path.resolve(here, '..', 'backups');
fs.mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(backupDir, `dashboard-${stamp}.dump`);

function connectionFields(config) {
  if (config.connectionString) {
    const url = new URL(config.connectionString);
    return {
      host: url.hostname,
      port: url.port || '5432',
      database: url.pathname.replace(/^\//, ''),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      sslmode: url.searchParams.get('sslmode') || (config.ssl ? 'require' : null),
    };
  }

  return {
    host: config.host,
    port: String(config.port || '5432'),
    database: config.database,
    user: config.user,
    password: config.password,
    sslmode: config.ssl ? 'require' : null,
  };
}

const config = resolvePgConfig();
const connection = connectionFields(config);
if (!(connection.host && connection.database && connection.user)) {
  throw new Error('DATABASE_URL or PG_HOST/PG_DATABASE/PG_USER must be configured before backup.');
}

const args = [
  '--format=custom',
  '--no-owner',
  '--no-privileges',
  '--file', output,
  '--host', connection.host,
  '--port', connection.port,
  '--username', connection.user,
  connection.database,
];

const result = spawnSync('pg_dump', args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(connection.password ? { PGPASSWORD: connection.password } : {}),
    ...(connection.sslmode ? { PGSSLMODE: connection.sslmode } : {}),
  },
});

if (result.error) {
  console.error('Database backup failed:', result.error.message);
  console.error('Install PostgreSQL client tools and make sure pg_dump is available on PATH.');
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status || 1);

console.log(`Database backup created: ${output}`);
