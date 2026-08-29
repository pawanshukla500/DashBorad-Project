import fs from 'node:fs/promises';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const file = 'C:/Users/shukl/Desktop/Impprtat File/DashBorad Project/outputs/amazon-sale-orders-20260806/Amazon Sale Order Template.xlsx';
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(file));
const sheets = await workbook.inspect({ kind: 'sheet', include: 'id,name', maxChars: 2000 });
console.log(sheets.ndjson);
const table = await workbook.inspect({
  kind: 'table',
  sheetId: 'Sale Orders',
  range: 'A1:N3',
  include: 'values,formulas',
  tableMaxRows: 5,
  tableMaxCols: 20,
  maxChars: 8000,
});
console.log(table.ndjson);
const errors = await workbook.inspect({
  kind: 'match',
  searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
  options: { useRegex: true, maxResults: 100 },
  summary: 'final formula error scan',
});
console.log(errors.ndjson);
const preview = await workbook.render({ sheetName: 'Sale Orders', range: 'A1:N3', scale: 1.25, format: 'png' });
await fs.writeFile(
  'C:/Users/shukl/Desktop/Impprtat File/DashBorad Project/outputs/amazon-sale-orders-20260806/Amazon Sale Order Template.png',
  new Uint8Array(await preview.arrayBuffer()),
);
