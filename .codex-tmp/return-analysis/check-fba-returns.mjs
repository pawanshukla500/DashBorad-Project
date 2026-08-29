import * as XLSX from '../../backend/node_modules/xlsx/xlsx.mjs';
import fs from 'node:fs/promises';

const returnFile = 'C:/Users/shukl/Desktop/401031020677.csv';
const paymentFile = 'C:/Users/shukl/Desktop/Payment template.xlsx';
const salesFile = 'C:/Users/shukl/Desktop/Amazon Sale Template.xlsx';
const targetOrderIds = new Set([
  '407-8365071-6002717', '403-8356490-9934766', '403-5227845-7389133',
  '406-8857803-1548328', '402-6167748-6153950', '405-5053541-2926717',
  '407-1054434-3364350', '407-2429081-2013132', '403-8389911-4278738',
  '406-9548657-4077152', '406-3051678-2615531', '406-6613196-7311504',
  '171-9588059-7045139', '406-5049807-2517134', '402-6771191-3031565',
  '407-0503077-6129156', '405-3565258-4350740', '405-8641829-4174732',
]);

const norm = value => String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
const numeric = value => {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
};
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;

async function sheetContext(file) {
  const buffer = await fs.readFile(file);
  const workbook = XLSX.read(buffer, {
    raw: true, cellDates: false, cellFormula: false, cellStyles: false,
    cellNF: false, cellHTML: false, cellText: false,
  });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const headers = new Map();
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: column })];
    const value = norm(cell?.v);
    if (value) headers.set(value, column);
  }
  return { sheetName, sheet, range, headers };
}

function valueAt(context, row, header) {
  const column = context.headers.get(norm(header));
  return column == null ? null : context.sheet[XLSX.utils.encode_cell({ r: row, c: column })]?.v ?? null;
}

const returnContext = await sheetContext(returnFile);
const returnRows = [];
for (let row = returnContext.range.s.r + 1; row <= returnContext.range.e.r; row += 1) {
  const orderId = String(valueAt(returnContext, row, 'order-id') ?? '').trim();
  if (!targetOrderIds.has(orderId)) continue;
  returnRows.push({
    csvRow: row + 1,
    returnDate: valueAt(returnContext, row, 'return-date'),
    orderId,
    sku: String(valueAt(returnContext, row, 'sku') ?? '').trim(),
    asin: valueAt(returnContext, row, 'asin'),
    fnsku: valueAt(returnContext, row, 'fnsku'),
    quantity: numeric(valueAt(returnContext, row, 'quantity')),
    fulfillmentCenter: valueAt(returnContext, row, 'fulfillment-center-id'),
    disposition: valueAt(returnContext, row, 'detailed-disposition'),
    reason: valueAt(returnContext, row, 'reason'),
    lpn: valueAt(returnContext, row, 'license-plate-number'),
    comment: valueAt(returnContext, row, 'customer-comments'),
  });
}

const returnedOrderIds = new Set(returnRows.map(row => row.orderId));
const salesContext = await sheetContext(salesFile);
const salesRows = [];
for (let row = salesContext.range.s.r + 1; row <= salesContext.range.e.r; row += 1) {
  const orderId = String(valueAt(salesContext, row, 'Amazon Order Id') ?? '').trim();
  if (!returnedOrderIds.has(orderId)) continue;
  salesRows.push({
    excelRow: row + 1,
    orderId,
    sku: String(valueAt(salesContext, row, 'Merchant SKU') ?? '').trim(),
    quantity: numeric(valueAt(salesContext, row, 'Quantity')),
    productAmount: numeric(valueAt(salesContext, row, 'Product Amount')),
    shippingAmount: numeric(valueAt(salesContext, row, 'Shipping Amount')),
    fnsku: valueAt(salesContext, row, 'FNSKU'),
    asin: valueAt(salesContext, row, 'ASIN'),
    fc: valueAt(salesContext, row, 'FC'),
  });
}

const paymentContext = await sheetContext(paymentFile);
const paymentLines = [];
for (let row = paymentContext.range.s.r + 1; row <= paymentContext.range.e.r; row += 1) {
  const orderId = String(valueAt(paymentContext, row, 'order-id') ?? '').trim();
  if (!returnedOrderIds.has(orderId)) continue;
  paymentLines.push({
    excelRow: row + 1,
    settlementId: valueAt(paymentContext, row, 'settlement-id'),
    transactionType: String(valueAt(paymentContext, row, 'transaction-type') ?? '').trim(),
    amountType: String(valueAt(paymentContext, row, 'amount-type') ?? '').trim(),
    description: String(valueAt(paymentContext, row, 'amount-description') ?? '').trim(),
    amount: numeric(valueAt(paymentContext, row, 'amount')),
    orderId,
    orderItemCode: String(valueAt(paymentContext, row, 'order-item-code') ?? '').trim(),
    sku: String(valueAt(paymentContext, row, 'sku') ?? '').trim(),
    quantity: numeric(valueAt(paymentContext, row, 'quantity-purchased')),
    fulfillment: valueAt(paymentContext, row, 'fulfillment-id'),
    postedDate: valueAt(paymentContext, row, 'posted-date'),
  });
}

const sum = (rows, predicate) => round(rows.filter(predicate).reduce((total, row) => total + row.amount, 0));
const returnByOrderSku = new Map();
for (const row of returnRows) {
  const key = `${row.orderId}|${row.sku}`;
  const group = returnByOrderSku.get(key) ?? { orderId: row.orderId, sku: row.sku, rows: [], quantity: 0 };
  group.rows.push(row);
  group.quantity += row.quantity;
  returnByOrderSku.set(key, group);
}

const salesByOrderSku = new Map();
for (const row of salesRows) {
  const key = `${row.orderId}|${row.sku}`;
  const group = salesByOrderSku.get(key) ?? { orderId: row.orderId, sku: row.sku, rows: [], quantity: 0, productValue: 0, shippingValue: 0 };
  group.rows.push(row);
  group.quantity += row.quantity;
  group.productValue += row.productAmount * row.quantity;
  group.shippingValue += row.shippingAmount;
  salesByOrderSku.set(key, group);
}

const comparisons = [...returnByOrderSku.values()].map(returnGroup => {
  const key = `${returnGroup.orderId}|${returnGroup.sku}`;
  const sale = salesByOrderSku.get(key) ?? null;
  const lines = paymentLines.filter(line => line.orderId === returnGroup.orderId && line.sku === returnGroup.sku);
  const refundProduct = sum(lines, line => line.transactionType === 'Refund' && ['Principal', 'Product Tax'].includes(line.description));
  const refundTotal = sum(lines, line => line.transactionType === 'Refund');
  const orderProduct = sum(lines, line => line.transactionType === 'Order' && ['Principal', 'Product Tax'].includes(line.description));
  return {
    orderId: returnGroup.orderId,
    sku: returnGroup.sku,
    physicalReturnUnits: returnGroup.quantity,
    lpnCount: new Set(returnGroup.rows.map(row => row.lpn)).size,
    lpns: returnGroup.rows.map(row => row.lpn),
    returnDates: [...new Set(returnGroup.rows.map(row => row.returnDate))],
    returnReasons: [...new Set(returnGroup.rows.map(row => row.reason))],
    dispositions: [...new Set(returnGroup.rows.map(row => row.disposition))],
    fulfillmentCenters: [...new Set(returnGroup.rows.map(row => row.fulfillmentCenter))],
    saleQuantity: sale?.quantity ?? null,
    saleProductValue: sale ? round(sale.productValue) : null,
    paymentOrderProduct: orderProduct,
    paymentRefundProduct: refundProduct,
    paymentRefundTotal: refundTotal,
    paymentRows: lines.map(line => line.excelRow),
    paymentTransactionTypes: [...new Set(lines.map(line => line.transactionType))],
  };
}).sort((left, right) => left.orderId.localeCompare(right.orderId) || left.sku.localeCompare(right.sku));

const orderLevelFeeRefunds = [...returnedOrderIds].map(orderId => {
  const lines = paymentLines.filter(line => line.orderId === orderId && line.transactionType === 'Fulfillment Fee Refund');
  return {
    orderId,
    lineCount: lines.length,
    amount: round(lines.reduce((total, line) => total + line.amount, 0)),
    hasSkuOrItemCode: lines.some(line => line.sku || line.orderItemCode),
    descriptions: [...new Set(lines.map(line => line.description))],
  };
}).filter(group => group.lineCount > 0);

const paymentRefundsWithoutFbaReturn = [...new Set(paymentLines.filter(line => line.transactionType === 'Refund').map(line => `${line.orderId}|${line.sku}`))]
  .filter(key => !returnByOrderSku.has(key))
  .map(key => {
    const [orderId, sku] = key.split('|');
    return { orderId, sku, refundProduct: sum(paymentLines, line => line.orderId === orderId && line.sku === sku && line.transactionType === 'Refund' && ['Principal', 'Product Tax'].includes(line.description)) };
  });

const result = {
  returnFile: {
    sheetName: returnContext.sheetName,
    headers: [...returnContext.headers.keys()],
    matchingRows: returnRows.length,
    matchingOrders: returnedOrderIds.size,
    matchingSkus: comparisons.length,
  },
  comparisons,
  paymentRefundsWithoutFbaReturn,
  orderLevelFeeRefunds,
  physicalReturnsWithoutPayment: comparisons.filter(row => row.paymentRows.length === 0).map(row => ({ orderId: row.orderId, sku: row.sku, physicalReturnUnits: row.physicalReturnUnits })),
};

console.log(JSON.stringify(result, null, 2));
