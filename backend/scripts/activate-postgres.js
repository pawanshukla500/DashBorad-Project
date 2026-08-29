/*
 * Safely promotes a verified PostgreSQL URL to the active backend connection.
 * The URL is supplied only through POSTGRES_ACTIVATION_URL and is never saved
 * in this script or printed to the terminal.
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

replaceRequiredSetting('DATABASE_URL', targetUrl);
replaceRequiredSetting('PG_SSL', 'false');
upsertSetting('DATABASE_ENGINE', 'postgresql');
fs.writeFileSync(envPath, contents, 'utf8');

console.log('Activated PostgreSQL in backend/.env (DATABASE_URL replaced; TLS setting set to false for this server).');
