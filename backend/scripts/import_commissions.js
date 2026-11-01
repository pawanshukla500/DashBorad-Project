import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEGACY_IMPORT_DISABLED_MESSAGE = 'The commission-only workbook importer is disabled because it bypasses complete Seller Hub extraction, review, and rate-period closure. Use the ReconCentral desktop app to review and publish rate cards.';

export async function importCommissions() {
  throw new Error(LEGACY_IMPORT_DISABLED_MESSAGE);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  importCommissions().catch(error => {
    console.error(`[rate-card/import] ${error.message}`);
    process.exitCode = 1;
  });
}
