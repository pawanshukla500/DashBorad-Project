import dotenv from 'dotenv';
import fs from 'fs';

/**
 * True under a test runner: Vitest sets VITEST in every worker, and
 * NODE_ENV=test covers any other runner.
 */
export function isTestEnvironment(env = process.env) {
  return Boolean(env.VITEST) || env.NODE_ENV === 'test';
}

/**
 * Load each existing .env file in `envPaths`, in order, into `env` without
 * overriding variables that are already set. Returns the files it loaded.
 *
 * Under a test runner it loads nothing. A developer's backend/.env holds the
 * production DATABASE_URL (reached through the SSH tunnel on localhost:5432),
 * so a test that reaches getPool() without setting its own DATABASE_URL must
 * find none, exactly as in CI, where no .env exists. Tests set every variable
 * they need themselves.
 */
export function loadEnvFiles(envPaths, env = process.env) {
  if (isTestEnvironment(env)) return [];
  const loaded = [];
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, override: false, processEnv: env });
      loaded.push(envPath);
    }
  }
  return loaded;
}
