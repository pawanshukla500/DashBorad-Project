import { createRequire } from 'node:module';

const requireFromBackend = createRequire('C:/Users/shukl/Desktop/Impprtat File/DashBorad Project/backend/package.json');
const XLSX = requireFromBackend('xlsx');

const sourcePath = 'C:/Users/shukl/Desktop/Payment template.xlsx';
const targetOrderIds = new Set(['402-6866527-9176308', '408-1102294-3821148']);
const workbook = XLSX.readFile(sourcePath, { cellDates: true, raw: true });

const output = { sheets: workbook.SheetNames, orders: {} };
for (const sheetName of workbook.SheetNames) {
  const sheet = workbook.Sheets[sheetName];
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const headers = new Map();

  for (let column = range.s.c; column <= range.e.c; column += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: column })];
    if (cell?.v != null && String(cell.v).trim()) {
      headers.set(String(cell.v).trim().toLowerCase(), column);
    }
  }

  const orderIdColumn = headers.get('order-id');
  if (orderIdColumn == null) continue;

  for (let row = range.s.r + 1; row <= range.e.r; row += 1) {
    const orderIdCell = sheet[XLSX.utils.encode_cell({ r: row, c: orderIdColumn })];
    const orderId = String(orderIdCell?.v ?? '').trim();
    if (!targetOrderIds.has(orderId)) continue;

    const value = (header) => {
      const column = headers.get(header);
      return column == null ? null : sheet[XLSX.utils.encode_cell({ r: row, c: column })]?.v ?? null;
    };
    const amount = Number(value('amount'));
    const amountType = String(value('amount-type') ?? '').trim();
    const amountDescription = String(value('amount-description') ?? '').trim();
    const key = `${amountType} | ${amountDescription}`;

    const bucket = output.orders[orderId] ||= { rows: [], totalsByParameter: {}, netSettlement: 0 };
    bucket.rows.push({
      row: row + 1,
      settlementId: value('settlement-id'),
      transactionType: value('transaction-type'),
      amountType,
      amountDescription,
      amount,
      fulfillmentId: value('fulfillment-id'),
      orderItemCode: value('order-item-code'),
      sku: value('sku'),
    });
    bucket.totalsByParameter[key] = (bucket.totalsByParameter[key] || 0) + amount;
    bucket.netSettlement += amount;
  }
}

for (const bucket of Object.values(output.orders)) {
  bucket.netSettlement = Number(bucket.netSettlement.toFixed(2));
  for (const key of Object.keys(bucket.totalsByParameter)) {
    bucket.totalsByParameter[key] = Number(bucket.totalsByParameter[key].toFixed(2));
  }
}

console.log(JSON.stringify(output, null, 2));
