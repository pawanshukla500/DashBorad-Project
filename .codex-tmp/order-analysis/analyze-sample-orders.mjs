import XLSX from 'xlsx';
import fs from 'node:fs/promises';

const paymentFile = 'C:/Users/shukl/Desktop/Payment template.xlsx';
const orderFile = 'C:/Users/shukl/Desktop/Amazon Sale Template.xlsx';
const orderIds = [
  '407-8365071-6002717', '403-8356490-9934766', '403-5227845-7389133',
  '406-8857803-1548328', '402-6167748-6153950', '405-5053541-2926717',
  '407-1054434-3364350', '407-2429081-2013132', '403-8389911-4278738',
  '406-9548657-4077152', '406-3051678-2615531', '406-6613196-7311504',
  '171-9588059-7045139', '406-5049807-2517134', '402-6771191-3031565',
  '407-0503077-6129156', '405-3565258-4350740', '405-8641829-4174732',
];

const targetIds = new Set(orderIds);
const norm = value => String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
const decimal = value => {
  if (value == null || value === '') return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;

function headerMap(sheet) {
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const map = new Map();
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    const value = norm(sheet[XLSX.utils.encode_cell({ r: range.s.r, c: column })]?.v);
    if (value) map.set(value, column);
  }
  return { range, map };
}

function valueAt(sheet, row, columns, header) {
  const column = columns.get(norm(header));
  return column == null ? null : sheet[XLSX.utils.encode_cell({ r: row, c: column })]?.v ?? null;
}

function rowsForOrders(file, orderHeader, wantedColumns) {
  const workbook = XLSX.readFile(file, { raw: true, cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const { range, map } = headerMap(sheet);
  const rows = [];
  const orderColumn = map.get(norm(orderHeader));
  if (orderColumn == null) throw new Error(`Missing ${orderHeader} in ${file}`);
  for (let row = range.s.r + 1; row <= range.e.r; row += 1) {
    const orderId = String(sheet[XLSX.utils.encode_cell({ r: row, c: orderColumn })]?.v ?? '').trim();
    if (!targetIds.has(orderId)) continue;
    const record = { excel_row: row + 1 };
    for (const header of wantedColumns) record[header] = valueAt(sheet, row, map, header);
    rows.push(record);
  }
  return { sheetName, headers: [...map.keys()], rows };
}

const salesSource = rowsForOrders(orderFile, 'Amazon Order Id', [
  'Amazon Order Id', 'Merchant SKU', 'FNSKU', 'ASIN', 'FC', 'Quantity',
  'Product Amount', 'Shipping Amount', 'Gift Amount', 'Customer Shipment Date',
  'Shipment City', 'Shipment State', 'Shipment Postal Code',
]);
const paymentSource = rowsForOrders(paymentFile, 'order-id', [
  'settlement-id', 'transaction-type', 'amount-type', 'amount-description', 'amount',
  'order-id', 'order-item-code', 'sku', 'quantity-purchased', 'fulfillment-id',
  'shipment-id', 'posted-date', 'posted-date-time', 'promotion-id', 'marketplace-name',
]);

const sales = salesSource.rows.map(row => ({
  row: row.excel_row,
  orderId: String(row['Amazon Order Id']),
  sku: row['Merchant SKU'],
  fnsku: row.FNSKU,
  asin: row.ASIN,
  fc: row.FC,
  quantity: decimal(row.Quantity),
  productAmount: decimal(row['Product Amount']),
  shippingAmount: decimal(row['Shipping Amount']),
  giftAmount: decimal(row['Gift Amount']),
  unitTotal: round(decimal(row['Product Amount']) + decimal(row['Shipping Amount']) + decimal(row['Gift Amount'])),
  extendedProductAmount: round(decimal(row['Product Amount']) * decimal(row.Quantity)),
  // Amazon's Sale Orders export carries Product Amount as a unit amount, while
  // Shipping/Gift amounts are already extended for that order line.
  extendedShippingAmount: round(decimal(row['Shipping Amount'])),
  extendedGiftAmount: round(decimal(row['Gift Amount'])),
  total: round((decimal(row['Product Amount']) * decimal(row.Quantity)) + decimal(row['Shipping Amount']) + decimal(row['Gift Amount'])),
  shipmentCity: row['Shipment City'],
  shipmentState: row['Shipment State'],
}));

const payments = paymentSource.rows.map(row => ({
  row: row.excel_row,
  settlementId: String(row['settlement-id'] ?? ''),
  transactionType: String(row['transaction-type'] ?? ''),
  amountType: String(row['amount-type'] ?? ''),
  description: String(row['amount-description'] ?? ''),
  amount: decimal(row.amount),
  orderId: String(row['order-id'] ?? ''),
  orderItemCode: String(row['order-item-code'] ?? ''),
  sku: row.sku == null ? null : String(row.sku),
  quantity: decimal(row['quantity-purchased']),
  fulfillment: String(row['fulfillment-id'] ?? ''),
  shipmentId: row['shipment-id'],
  postedDate: row['posted-date'],
}));

const salesByOrder = new Map();
for (const sale of sales) {
  const group = salesByOrder.get(sale.orderId) ?? [];
  group.push(sale);
  salesByOrder.set(sale.orderId, group);
}
const salesByOrderSku = new Map();
for (const sale of sales) {
  const key = [sale.orderId, sale.sku ?? ''].join('|');
  const current = salesByOrderSku.get(key) ?? {
    rows: [], quantity: 0, productAmount: 0, shippingAmount: 0, giftAmount: 0, total: 0,
    fc: new Set(), asin: new Set(), fnsku: new Set(), shipmentCity: new Set(), shipmentState: new Set(),
  };
  current.rows.push(sale.row);
  current.quantity += sale.quantity;
  current.productAmount += sale.extendedProductAmount;
  current.shippingAmount += sale.extendedShippingAmount;
  current.giftAmount += sale.extendedGiftAmount;
  current.total += sale.total;
  if (sale.fc) current.fc.add(sale.fc);
  if (sale.asin) current.asin.add(sale.asin);
  if (sale.fnsku) current.fnsku.add(sale.fnsku);
  if (sale.shipmentCity) current.shipmentCity.add(sale.shipmentCity);
  if (sale.shipmentState) current.shipmentState.add(sale.shipmentState);
  salesByOrderSku.set(key, current);
}
const paymentByItem = new Map();
for (const line of payments) {
  const key = [line.orderId, line.orderItemCode, line.sku ?? ''].join('|');
  const group = paymentByItem.get(key) ?? [];
  group.push(line);
  paymentByItem.set(key, group);
}

function sumByDescription(lines, description) {
  return round(lines.filter(line => line.description === description).reduce((sum, line) => sum + line.amount, 0));
}
function sumLike(lines, expression) {
  return round(lines.filter(line => expression.test(line.description)).reduce((sum, line) => sum + line.amount, 0));
}
function amountList(lines) {
  return [...new Set(lines.map(line => line.description))];
}
function classifyItem(lines) {
  const descriptions = amountList(lines);
  const transactionTypes = [...new Set(lines.map(line => line.transactionType))];
  const has = expression => descriptions.some(description => expression.test(description));
  const fees = [];
  if (has(/^FBA Pick & Pack Fee/)) fees.push('pick_pack');
  if (has(/^FBA Weight Handling Fee/)) fees.push('weight_handling');
  if (has(/^Technology Fee/)) fees.push('technology');
  if (has(/^Fixed closing fee/)) fees.push('closing');
  if (has(/^Commission|^Refund commission/)) fees.push('commission');
  if (has(/Shipping discount/i)) fees.push('shipping_discount');
  if (has(/^Shipping$/) || has(/^Shipping tax$/i)) fees.push('shipping_credit');
  if (has(/^TDS/)) fees.push('tds');
  if (has(/^TCS/)) fees.push(descriptions.some(d => d === 'TCS-IGST') ? 'tcs_igst' : 'tcs_cgst_sgst');
  if (transactionTypes.some(type => /refund/i.test(type))) fees.push('refund');
  if (transactionTypes.some(type => /fulfillment fee refund/i.test(type))) fees.push('fulfillment_fee_refund');
  return fees;
}

const itemReports = [];
for (const [key, lines] of paymentByItem) {
  const [orderId, orderItemCode, sku] = key.split('|');
  const sale = salesByOrderSku.get([orderId, sku].join('|')) ?? null;
  const principal = sumByDescription(lines, 'Principal');
  const productTax = sumByDescription(lines, 'Product Tax');
  const orderPrincipal = round(lines.filter(line => line.transactionType === 'Order' && line.description === 'Principal').reduce((sum, line) => sum + line.amount, 0));
  const orderProductTax = round(lines.filter(line => line.transactionType === 'Order' && line.description === 'Product Tax').reduce((sum, line) => sum + line.amount, 0));
  const refundPrincipal = round(lines.filter(line => line.transactionType === 'Refund' && line.description === 'Principal').reduce((sum, line) => sum + line.amount, 0));
  const refundProductTax = round(lines.filter(line => line.transactionType === 'Refund' && line.description === 'Product Tax').reduce((sum, line) => sum + line.amount, 0));
  const shipping = sumByDescription(lines, 'Shipping');
  const shippingTax = round(sumByDescription(lines, 'Shipping tax') + sumByDescription(lines, 'Shipping Tax'));
  const shippingDiscount = sumLike(lines, /^Shipping discount$/i);
  const shippingTaxDiscount = sumLike(lines, /^Shipping tax discount$/i);
  const orderShipping = round(lines.filter(line => line.transactionType === 'Order' && line.description === 'Shipping').reduce((sum, line) => sum + line.amount, 0));
  const orderShippingTax = round(lines.filter(line => line.transactionType === 'Order' && /^Shipping tax$/i.test(line.description)).reduce((sum, line) => sum + line.amount, 0));
  const orderShippingDiscount = round(lines.filter(line => line.transactionType === 'Order' && /^Shipping discount$/i.test(line.description)).reduce((sum, line) => sum + line.amount, 0));
  const orderShippingTaxDiscount = round(lines.filter(line => line.transactionType === 'Order' && /^Shipping tax discount$/i.test(line.description)).reduce((sum, line) => sum + line.amount, 0));
  const totals = {
    principal,
    productTax,
    productSale: round(principal + productTax),
    orderProductSale: round(orderPrincipal + orderProductTax),
    refundProductSale: round(refundPrincipal + refundProductTax),
    shipping,
    shippingTax,
    shippingDiscount,
    shippingTaxDiscount,
    netShipping: round(shipping + shippingTax + shippingDiscount + shippingTaxDiscount),
    orderCustomerShipping: round(orderShipping + orderShippingTax),
    orderShippingDiscount: round(orderShippingDiscount + orderShippingTaxDiscount),
    orderNetShipping: round(orderShipping + orderShippingTax + orderShippingDiscount + orderShippingTaxDiscount),
    tcs: sumLike(lines, /^TCS-/),
    tds: sumLike(lines, /^TDS/),
    pickPack: sumLike(lines, /^FBA Pick & Pack Fee/),
    weightHandling: sumLike(lines, /^FBA Weight Handling Fee/),
    technology: sumLike(lines, /^Technology Fee/),
    closing: sumLike(lines, /^Fixed closing fee/),
    commission: sumLike(lines, /^(Commission|Refund commission)/i),
    netSettlement: round(lines.reduce((sum, line) => sum + line.amount, 0)),
  };
  const other = lines.filter(line => ![
    'Principal', 'Product Tax', 'Shipping', 'Shipping tax', 'Shipping Tax',
    'Shipping discount', 'Shipping tax discount',
  ].includes(line.description)
    && !/^TCS-|^TDS|^FBA Pick & Pack Fee|^FBA Weight Handling Fee|^Technology Fee|^Fixed closing fee|^(Commission|Refund commission)/i.test(line.description));
  itemReports.push({
    orderId, orderItemCode, sku, saleRow: sale?.row ?? null, paymentRows: lines.map(line => line.row),
    orderQuantity: sale?.quantity ?? null, paymentQuantity: [...new Set(lines.map(line => line.quantity))],
    fulfillment: [...new Set(lines.map(line => line.fulfillment))],
    transactionTypes: [...new Set(lines.map(line => line.transactionType))],
    settlementIds: [...new Set(lines.map(line => line.settlementId))],
    shipmentIds: [...new Set(lines.map(line => line.shipmentId))],
    sale: sale ? {
      sourceRows: sale.rows,
      productAmount: round(sale.productAmount), shippingAmount: round(sale.shippingAmount),
      giftAmount: round(sale.giftAmount), total: round(sale.total),
      fc: [...sale.fc], asin: [...sale.asin], fnsku: [...sale.fnsku],
    } : null,
    totals,
    salesReconciliationDelta: sale ? round(sale.total - totals.orderProductSale - totals.orderCustomerShipping) : null,
    parameterSet: classifyItem(lines),
    descriptions: amountList(lines),
    otherLines: other.map(line => ({ description: line.description, amount: line.amount, transactionType: line.transactionType })),
  });
}
itemReports.sort((a, b) => a.orderId.localeCompare(b.orderId) || a.orderItemCode.localeCompare(b.orderItemCode));

const orderReports = orderIds.map(orderId => {
  const saleRows = salesByOrder.get(orderId) ?? [];
  const items = itemReports.filter(item => item.orderId === orderId);
  const paymentLines = payments.filter(line => line.orderId === orderId);
  return {
    orderId,
    saleRows: saleRows.length,
    saleQuantity: round(saleRows.reduce((sum, row) => sum + row.quantity, 0)),
    saleTotal: round(saleRows.reduce((sum, row) => sum + row.total, 0)),
    saleProduct: round(saleRows.reduce((sum, row) => sum + row.extendedProductAmount, 0)),
    saleShipping: round(saleRows.reduce((sum, row) => sum + row.extendedShippingAmount, 0)),
    saleGift: round(saleRows.reduce((sum, row) => sum + row.extendedGiftAmount, 0)),
    paymentItemGroups: items.length,
    paymentLines: paymentLines.length,
    paymentNet: round(paymentLines.reduce((sum, line) => sum + line.amount, 0)),
    paymentGrossProduct: round(items.reduce((sum, item) => sum + item.totals.productSale, 0)),
    paymentOrderProduct: round(items.reduce((sum, item) => sum + item.totals.orderProductSale, 0)),
    paymentRefundProduct: round(items.reduce((sum, item) => sum + item.totals.refundProductSale, 0)),
    paymentNetShipping: round(items.reduce((sum, item) => sum + item.totals.netShipping, 0)),
    paymentOrderCustomerShipping: round(items.reduce((sum, item) => sum + item.totals.orderCustomerShipping, 0)),
    paymentOrderShippingDiscount: round(items.reduce((sum, item) => sum + item.totals.orderShippingDiscount, 0)),
    salesToOrderCreditsDelta: round(saleRows.reduce((sum, row) => sum + row.total, 0) - items.reduce((sum, item) => sum + item.totals.orderProductSale + item.totals.orderCustomerShipping, 0)),
    fulfillment: [...new Set(paymentLines.map(line => line.fulfillment))],
    transactionTypes: [...new Set(paymentLines.map(line => line.transactionType))],
    parameters: [...new Set(items.flatMap(item => item.parameterSet))].sort(),
    sales: saleRows,
    items,
  };
});

const patternGroups = new Map();
for (const item of itemReports) {
  const key = item.parameterSet.join('|');
  const group = patternGroups.get(key) ?? { pattern: item.parameterSet, items: [] };
  group.items.push({ orderId: item.orderId, orderItemCode: item.orderItemCode, sku: item.sku, net: item.totals.netSettlement, sale: item.sale?.total ?? null });
  patternGroups.set(key, group);
}

const report = {
  sources: {
    paymentFile, paymentSheet: paymentSource.sheetName,
    orderFile, orderSheet: salesSource.sheetName,
  },
  requestedOrders: orderIds.length,
  found: {
    saleOrderIds: orderReports.filter(order => order.saleRows > 0).length,
    paymentOrderIds: orderReports.filter(order => order.paymentLines > 0).length,
    saleRows: sales.length,
    paymentLines: payments.length,
    paymentItemGroups: itemReports.length,
  },
  orderReports,
  patternGroups: [...patternGroups.values()].sort((a, b) => b.items.length - a.items.length),
  unmatchedSaleRows: sales.filter(sale => !itemReports.some(item => item.orderId === sale.orderId && item.sku === sale.sku)),
  unmatchedPaymentItems: itemReports.filter(item => !item.sale),
};

const outputPath = 'C:/Users/shukl/Desktop/Impprtat File/DashBorad Project/.codex-tmp/order-analysis/sample-orders-report.json';
await fs.writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ outputPath, found: report.found }, null, 2));
