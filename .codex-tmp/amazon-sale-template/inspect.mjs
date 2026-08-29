import fs from 'node:fs/promises';
import path from 'node:path';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const source = 'C:/Users/shukl/Desktop/Amazon Sale Template.xlsx';
const outputDir = 'C:/Users/shukl/Desktop/Impprtat File/DashBorad Project/.codex-tmp/amazon-sale-template/preview';
await fs.mkdir(outputDir, { recursive: true });

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(source));
const summary = await workbook.inspect({
  kind: 'workbook,sheet,table,region',
  maxChars: 12000,
  tableMaxRows: 8,
  tableMaxCols: 50,
  tableMaxCellChars: 120,
});
console.log(summary.ndjson);

const sheets = [];
for (const sheet of workbook.worksheets.items) {
  const used = sheet.getUsedRange();
  const previewRange = 'A1:AZ20';
  const table = await workbook.inspect({
    kind: 'table',
    sheetId: sheet.id,
    range: previewRange,
    include: 'values,formulas',
    maxChars: 16000,
    tableMaxRows: 12,
    tableMaxCols: 60,
    tableMaxCellChars: 160,
  });
  console.log(table.ndjson);
  const styles = await workbook.inspect({
    kind: 'computedStyle',
    sheetId: sheet.id,
    range: 'A1:AZ5',
    maxChars: 6000,
  });
  console.log(styles.ndjson);
  const preview = await workbook.render({ sheetName: sheet.name, range: previewRange, scale: 0.75, format: 'png' });
  const safeName = sheet.name.replace(/[^a-z0-9_-]+/gi, '_');
  const previewPath = path.join(outputDir, `${safeName}.png`);
  await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
  sheets.push({ name: sheet.name, id: sheet.id, usedRange: used?.address, previewPath });
}
console.log(JSON.stringify({ sheets }, null, 2));
