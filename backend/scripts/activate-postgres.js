/*
 * Safely promotes a verified PostgreSQL URL to the active backend connection.
 * The URL is supplied only through POSTGRES_ACTIVATION_URL and is never printed
 * to the terminal.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const targetUrl = process.env.POSTGRES_ACTIVATION_URL?.trim();
if (!targetUrl?.startsWith('postgres')) {
  throw new Error('POSTGRES_ACTIVATION_URL must contain the verified PostgreSQL connection URL.');
}

const envPath = path.resolve(process.cwd(), '.env');
let contents = fs.readFileSync(envPath, 'utf8');

function replaceRequiredSetting(name, value) {
  const expression = new RegExp(`^\\s*${name}\\s*=.*$`, 'm');
  if (!expression.test(contents)) throw new Error(`${name} is missing from ${envPath}.`);
  contents = contents.replace(expression, `${name}=${value}`);
}

function upsertSetting(name, value) {
  const expression = new RegExp(`^\\s*${name}\\s*=.*$`, 'm');
  contents = expression.test(contents)
    ? contents.replace(expression, `${name}=${value}`)
    : `${contents.replace(/\s*$/, '\n')}\n${name}=${value}\n`;
}

function deleteSetting(name) {
  const expression = new RegExp(`^\\s*${name}\\s*=.*(?:\\r?\\n)?`, 'm');
  contents = contents.replace(expression, '');
}

function inferPgSsl(connectionString) {
  const explicit = process.env.POSTGRES_ACTIVATION_PG_SSL?.trim();
  if (explicit) return explicit.toLowerCase() === 'true' ? 'true' : 'false';
  try {
    const sslmode = new URL(connectionString).searchParams.get('sslmode')?.toLowerCase();
    if (['require', 'verify-ca', 'verify-full'].includes(sslmode)) return 'true';
    if (sslmode === 'disable') return 'false';
  } catch {
    // The validation above already checked that this is a PostgreSQL URL.
  }
  return process.env.PG_SSL?.trim() || 'false';
}

replaceRequiredSetting('DATABASE_URL', targetUrl);
replaceRequiredSetting('PG_SSL', inferPgSsl(targetUrl));
upsertSetting('DATABASE_ENGINE', 'postgresql');
deleteSetting('POSTGRES_DATABASE_URL');
fs.writeFileSync(envPath, contents, 'utf8');

console.log('Activated PostgreSQL in backend/.env (DATABASE_URL replaced; DATABASE_ENGINE set to postgresql).');
