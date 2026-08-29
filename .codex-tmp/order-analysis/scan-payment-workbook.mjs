import XLSX from 'xlsx';

const file = 'C:/Users/shukl/Desktop/Payment template.xlsx';
const targetOrderIds = new Set(['406-5801026-0047530', '407-2429081-2013132']);
const workbook = XLSX.readFile(file, { cellDates: false, raw: true });
const sheetName = workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];
const range = XLSX.utils.decode_range(sheet['!ref']);
const headers = new Map();

for (let column = range.s.c; column <= range.e.c; column += 1) {
  const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: column })];
  const value = String(cell?.v ?? '').trim().toLowerCase();
  if (value) headers.set(value, column);
}

const orderIdColumn = headers.get('order-id');
const wanted = [
  'settlement-id', 'transaction-type', 'amount-type', 'amount-description', 'amount',
  'order-id', 'order-item-code', 'sku', 'quantity-purchased', 'fulfillment-id',
  'shipment-id', 'posted-date', 'posted-date-time', 'promotion-id', 'marketplace-name',
];
const rows = [];

for (let row = range.s.r + 1; row <= range.e.r; row += 1) {
  const orderId = String(sheet[XLSX.utils.encode_cell({ r: row, c: orderIdColumn })]?.v ?? '').trim();
  if (!targetOrderIds.has(orderId)) continue;
  const result = { excel_row: row + 1 };
  for (const header of wanted) {
    const col = headers.get(header);
    result[header] = col == null ? null : sheet[XLSX.utils.encode_cell({ r: row, c: col })]?.v ?? null;
  }
  rows.push(result);
}

console.log(JSON.stringify({
  file,
  sheetName,
  headerRow: range.s.r + 1,
  headers: Object.fromEntries([...headers.entries()].filter(([name]) => wanted.includes(name))),
  rows,
}, null, 2));
