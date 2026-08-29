import fs from 'node:fs/promises';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const outputDir = 'C:/Users/shukl/Desktop/Impprtat File/DashBorad Project/outputs/amazon-sale-orders-20260806';
await fs.mkdir(outputDir, { recursive: true });

const workbook = Workbook.create();
const sheet = workbook.worksheets.add('Sale Orders');
sheet.showGridLines = false;

const rows = [
  [
    'Customer Shipment Date', 'Merchant SKU', 'FNSKU', 'ASIN', 'FC', 'Quantity',
    'Amazon Order Id', 'Currency', 'Product Amount', 'Shipping Amount', 'Gift Amount',
    'Shipment To City', 'Shipment To State', 'Shipment To Postal Code',
  ],
  [
    '2026-04-30T23:47:50+05:30', 'SKU-TEE-BLK-M', 'X001FNSKU', 'B0EXAMPLE01',
    'BOM5', 1, '405-3118393-5670756', 'INR', 799, 38.1, 0,
    'PUNE', 'MAHARASHTRA', '411001',
  ],
  [
    '2026-04-30T22:42:46+05:30', 'SKU-TEE-WHT-L', 'X002FNSKU', 'B0EXAMPLE02',
    'DEL4', 1, '405-7984469-3781915', 'INR', 999, 0, 0,
    'NEW DELHI', 'DELHI', '110045',
  ],
];

sheet.getRange('A1:N3').values = rows;
sheet.getRange('A1:N1').format = {
  fill: '#232F3E',
  font: { bold: true, color: '#FFFFFF' },
  verticalAlignment: 'center',
  wrapText: true,
  borders: { preset: 'outside', style: 'thin', color: '#131A22' },
};
sheet.getRange('A1:N1').format.rowHeight = 34;
sheet.getRange('A2:N3').format = {
  fill: '#FFFDF8',
  font: { color: '#1F2937' },
  verticalAlignment: 'center',
  borders: {
    insideHorizontal: { style: 'thin', color: '#E5E7EB' },
    bottom: { style: 'thin', color: '#D1D5DB' },
  },
};
sheet.getRange('A2:N3').format.rowHeight = 22;
sheet.getRange('A2:A3').format.numberFormat = 'yyyy-mm-dd hh:mm';
sheet.getRange('F2:F3').format.numberFormat = '#,##0';
sheet.getRange('I2:K3').format.numberFormat = '#,##0.00';
sheet.getRange('B2:E3').format.numberFormat = '@';
sheet.getRange('G2:H3').format.numberFormat = '@';
sheet.getRange('L2:N3').format.numberFormat = '@';

const widths = [28, 34, 16, 16, 10, 11, 24, 11, 16, 17, 14, 22, 23, 25];
widths.forEach((width, column) => {
  sheet.getRangeByIndexes(0, column, 3, 1).format.columnWidth = width;
});
sheet.freezePanes.freezeRows(1);

const preview = await workbook.render({ sheetName: 'Sale Orders', range: 'A1:N3', scale: 1.25, format: 'png' });
await fs.writeFile(`${outputDir}/Amazon Sale Order Template.png`, new Uint8Array(await preview.arrayBuffer()));

const inspection = await workbook.inspect({
  kind: 'table',
  sheetId: sheet.id,
  range: 'A1:N3',
  include: 'values,formulas',
  tableMaxRows: 5,
  tableMaxCols: 20,
  maxChars: 8000,
});
console.log(inspection.ndjson);
const errors = await workbook.inspect({
  kind: 'match',
  searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
  options: { useRegex: true, maxResults: 100 },
  summary: 'final formula error scan',
});
console.log(errors.ndjson);

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(`${outputDir}/Amazon Sale Order Template.xlsx`);
console.log(JSON.stringify({ outputDir }));
