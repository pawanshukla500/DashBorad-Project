import { describe, expect, it } from 'vitest';
import { schemaMigrationsEnabled } from '../db/initDb.js';

describe('startup schema migrations', () => {
  it('run in the production container', () => {
    expect(schemaMigrationsEnabled({ NODE_ENV: 'production' })).toBe(true);
  });

  it('are skipped for a development backend, which may point at the shared production database', () => {
    expect(schemaMigrationsEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(schemaMigrationsEnabled({})).toBe(false);
  });

  it('run in development only with an explicit opt-in', () => {
    expect(schemaMigrationsEnabled({ NODE_ENV: 'development', RUN_SCHEMA_MIGRATIONS: 'true' })).toBe(true);
    expect(schemaMigrationsEnabled({ RUN_SCHEMA_MIGRATIONS: '1' })).toBe(true);
    expect(schemaMigrationsEnabled({ RUN_SCHEMA_MIGRATIONS: 'no' })).toBe(false);
  });
});
