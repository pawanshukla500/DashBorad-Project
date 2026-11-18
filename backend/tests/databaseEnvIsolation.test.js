import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATABASE_ENV_VARS, stubNoDatabaseEnv } from './helpers/databaseEnv.js';
import { isDbConfigured } from '../db/index.js';
import { desktopDatabaseProvisioningForRole } from '../utils/desktopProvisioning.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

// Source files whose environment reads decide which database the backend
// (or a provisioned desktop worker) connects to.
const CONNECTION_SOURCES = ['../db/index.js', '../utils/desktopProvisioning.js'];
const CONNECTION_VARIABLE = /^(?:[A-Z0-9_]*DATABASE_URL|PG_?(?:HOST|PORT|DATABASE|USER|PASSWORD))$/;

describe('stubNoDatabaseEnv', () => {
  it('covers every connection variable the backend reads', () => {
    const read = new Set();
    for (const file of CONNECTION_SOURCES) {
      const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
      for (const [, name] of source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) {
        if (CONNECTION_VARIABLE.test(name)) read.add(name);
      }
    }

    // Sanity: the scan finds the variables we know are read.
    expect(read).toContain('DATABASE_URL');
    expect(read).toContain('PGHOST');
    expect(read).toContain('DESKTOP_DATABASE_URL');
    expect([...read].filter(name => !DATABASE_ENV_VARS.includes(name))).toEqual([]);
  });

  it('leaves no database configured even when the shell exports every variable', async () => {
    for (const name of DATABASE_ENV_VARS) {
      vi.stubEnv(name, name.endsWith('DATABASE_URL')
        ? 'postgresql://shell:shell@shell-export.invalid:5432/paymentapp'
        : 'shell-export.invalid');
    }
    expect(await isDbConfigured()).toBe(true);

    stubNoDatabaseEnv();

    for (const name of DATABASE_ENV_VARS) expect(process.env[name]).toBeUndefined();
    expect(await isDbConfigured()).toBe(false);
    expect(desktopDatabaseProvisioningForRole('operator').databaseUrl).toBe('');
    expect(desktopDatabaseProvisioningForRole('analyst').databaseUrl).toBe('');
  });
});
