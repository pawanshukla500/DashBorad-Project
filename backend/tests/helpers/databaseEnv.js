import { vi } from 'vitest';

// Every variable through which backend code picks up a database connection
// (db/index.js and utils/desktopProvisioning.js). Tests no longer load any
// .env (utils/loadEnv.js), but a developer's shell can still export one of
// these, possibly pointing at production through the SSH tunnel on
// localhost:5432. A test that runs database-aware code without mocking
// db/index.js starts from none of them, as in CI.
// tests/databaseEnvIsolation.test.js fails if the code reads one not listed.
export const DATABASE_ENV_VARS = Object.freeze([
  'DATABASE_URL',
  'DESKTOP_DATABASE_URL',
  'DESKTOP_ANALYST_DATABASE_URL',
  'PG_HOST', 'PGHOST',
  'PG_PORT', 'PGPORT',
  'PG_DATABASE', 'PGDATABASE',
  'PG_USER', 'PGUSER',
  'PG_PASSWORD', 'PGPASSWORD',
]);

/** Unset every database variable for the current test; undo with vi.unstubAllEnvs(). */
export function stubNoDatabaseEnv() {
  for (const name of DATABASE_ENV_VARS) vi.stubEnv(name, undefined);
}
