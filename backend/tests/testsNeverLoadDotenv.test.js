import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTestEnvironment, loadEnvFiles } from '../utils/loadEnv.js';

// A developer's backend/.env holds the production DATABASE_URL, reached
// through the SSH tunnel on localhost:5432. Under a test runner no backend
// module may load any .env, so every test sees what CI sees (no .env at all)
// and a test that reaches getPool() without its own DATABASE_URL finds none.

const LEAKED_URL = 'postgresql://leak_user:leak_pass@dotenv-leak.invalid:5432/paymentapp';
const CANARY = 'RECON_DOTENV_LEAK_CANARY';

let tmpDir;
let envFile;

beforeEach(() => {
  // A real .env file at a cascade path: every loader resolves
  // `${process.cwd()}/.env`, and process.cwd() is pointed here below.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-dotenv-'));
  envFile = path.join(tmpDir, '.env');
  fs.writeFileSync(envFile, `DATABASE_URL=${LEAKED_URL}\nPG_HOST=dotenv-leak.invalid\n${CANARY}=loaded\n`);
  for (const name of ['DATABASE_URL', 'PG_HOST', 'PGHOST', CANARY]) vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.doUnmock('dotenv');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function importWithCwd(specifier) {
  vi.resetModules();
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  return import(specifier);
}

describe('isTestEnvironment', () => {
  it('recognises Vitest and NODE_ENV=test, and nothing else', () => {
    expect(isTestEnvironment({ VITEST: 'true' })).toBe(true);
    expect(isTestEnvironment({ NODE_ENV: 'test' })).toBe(true);
    expect(isTestEnvironment({ NODE_ENV: 'development' })).toBe(false);
    expect(isTestEnvironment({ NODE_ENV: 'production' })).toBe(false);
    expect(isTestEnvironment({})).toBe(false);
  });
});

describe('loadEnvFiles', () => {
  it('loads nothing under Vitest', () => {
    const env = { VITEST: 'true' };
    expect(loadEnvFiles([envFile], env)).toEqual([]);
    expect(env).toEqual({ VITEST: 'true' });
  });

  it('loads nothing when NODE_ENV=test', () => {
    const env = { NODE_ENV: 'test' };
    expect(loadEnvFiles([envFile], env)).toEqual([]);
    expect(env).toEqual({ NODE_ENV: 'test' });
  });

  it('loads existing files outside tests without overriding variables already set', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = { NODE_ENV: 'development', [CANARY]: 'from-shell' };

    expect(loadEnvFiles([path.join(tmpDir, 'missing.env'), envFile], env)).toEqual([envFile]);

    expect(env.DATABASE_URL).toBe(LEAKED_URL);
    expect(env[CANARY]).toBe('from-shell');
    // Only the env object passed in is written.
    expect(process.env.DATABASE_URL).toBeUndefined();
  });
});

describe('backend modules under Vitest', () => {
  it('db/index.js applies no value from a .env on its cascade', async () => {
    expect(process.env.VITEST).toBeTruthy();

    const db = await importWithCwd('../db/index.js');

    expect(process.env[CANARY]).toBeUndefined();
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.PG_HOST).toBeUndefined();
    expect(await db.isDbConfigured()).toBe(false);
  });

  // Importing the whole route graph from scratch takes several seconds when
  // the full suite shares the CPU.
  it('server.js and its route graph (firebaseAdmin, catalog sync script) apply no .env value', { timeout: 60_000 }, async () => {
    await importWithCwd('../server.js');

    expect(process.env[CANARY]).toBeUndefined();
    expect(process.env.DATABASE_URL).toBeUndefined();
  });

  it('would read that .env with the test-runner guard off (proves the file sits on the cascade)', async () => {
    // dotenv is mocked so nothing is applied: in a developer checkout the
    // cascade also finds the real backend/.env.
    const config = vi.fn(() => ({ parsed: {} }));
    vi.doMock('dotenv', () => ({ default: { config }, config }));
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'development');

    await importWithCwd('../db/index.js');

    expect(config).toHaveBeenCalledWith(expect.objectContaining({ path: envFile, override: false }));
    expect(process.env[CANARY]).toBeUndefined();
  });
});
