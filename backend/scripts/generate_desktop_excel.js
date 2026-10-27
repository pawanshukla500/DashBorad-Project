import { generateBrandwiseRateCardExcel } from '../services/brandwiseExcelExport.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

async function main() {
  try {
    console.log('Generating Brand-Wise Rate Card Excel file...');
    const result = await generateBrandwiseRateCardExcel();
    console.log('\n======================================================');
    console.log('✓ EXCEL WORKBOOK GENERATED SUCCESSFULLY');
    console.log('======================================================');
    console.log(`File Path:      ${result.filePath}`);
    console.log(`Sheets Count:   ${result.sheetsCount}`);
    console.log(`Sheets:         ${result.sheets.join(', ')}`);
    console.log(`Total Records:  ${result.totalRecords}`);
    console.log(`Catalog Items:  ${result.catalogCount}`);
    console.log('======================================================\n');
  } catch (err) {
    console.error('Failed to generate Excel file:', err);
    process.exit(1);
  }
}

main();
