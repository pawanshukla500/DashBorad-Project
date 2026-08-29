import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const sourcePath = 'C:/Users/shukl/Desktop/Payment template.xlsx';
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(sourcePath));

const sheetInfo = await workbook.inspect({
  kind: 'sheet',
  include: 'id,name',
  maxChars: 3000,
});

console.log(sheetInfo.ndjson);

const sheetMatch = /"name":"([^"]+)"/.exec(sheetInfo.ndjson);
if (!sheetMatch) throw new Error('No worksheet found');
const sheetName = sheetMatch[1];

const topRows = await workbook.inspect({
  kind: 'table',
  sheetId: sheetName,
  range: 'A1:X15',
  include: 'values',
  tableMaxRows: 15,
  tableMaxCols: 24,
  tableMaxCellChars: 80,
  maxChars: 10000,
});

console.log(topRows.ndjson);
