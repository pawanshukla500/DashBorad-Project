import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const uploadRoutes = fs.readFileSync(new URL('../routes/upload.js', import.meta.url), 'utf8');
const uploadSchema = fs.readFileSync(new URL('../db/initDb.js', import.meta.url), 'utf8');
const dataCenter = fs.readFileSync(new URL('../../frontend/src/pages/UploadPage.jsx', import.meta.url), 'utf8');
const apiClient = fs.readFileSync(new URL('../../frontend/src/api/client.js', import.meta.url), 'utf8');

describe('cleared upload audit retention', () => {
  it('marks affected upload records as cleared instead of deleting their evidence', () => {
    expect(uploadRoutes).toContain('UPDATE upload_log');
    expect(uploadRoutes).toContain('data_cleared_at = NOW()');
    expect(uploadRoutes).toContain('cleared_row_counts = $1::jsonb');
    expect(uploadRoutes).toContain("action: 'upload_data_cleared'");
    expect(uploadRoutes).not.toContain('DELETE FROM upload_log');
  });

  it('migrates and exposes the clear metadata', () => {
    expect(uploadSchema).toContain('UPLOAD_AUDIT_RETENTION_SCHEMA_VERSION');
    expect(uploadSchema).toContain('ADD COLUMN IF NOT EXISTS data_cleared_at');
    expect(uploadSchema).toContain('ADD COLUMN IF NOT EXISTS clear_reason');
    expect(uploadSchema).toContain('ADD COLUMN IF NOT EXISTS cleared_row_counts');
    expect(uploadRoutes).toContain('WHERE data_cleared_at IS NULL ORDER BY uploaded_at DESC');
  });

  it('requires a reason and makes retained clears discoverable in the UI', () => {
    expect(uploadRoutes).toContain('A clear reason is required so this removal can be audited.');
    expect(apiClient).toContain('data: { reason }');
    expect(dataCenter).toContain('The original filename, upload counts, your remark');
    expect(dataCenter).toContain("<option value=\"cleared\">Cleared data</option>");
    expect(dataCenter).toContain('Data cleared {clearedAt}');
  });
});
