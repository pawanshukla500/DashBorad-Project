import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importCommissions, LEGACY_IMPORT_DISABLED_MESSAGE } from '../scripts/import_commissions.js';

describe('legacy commission workbook importer', () => {
  it('refuses commission-only publication and directs the operator to reviewed publishing', async () => {
    await expect(importCommissions()).rejects.toThrow(LEGACY_IMPORT_DISABLED_MESSAGE);

    const script = fileURLToPath(new URL('../scripts/import_commissions.js', import.meta.url));
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(LEGACY_IMPORT_DISABLED_MESSAGE);
  });

  it('has no database or spreadsheet write path', () => {
    const source = fs.readFileSync(new URL('../scripts/import_commissions.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/getPool|INSERT INTO|xlsx|dotenv/i);
  });
});
