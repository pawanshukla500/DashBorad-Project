import fs from 'node:fs/promises';

const input = 'C:/Users/shukl/Desktop/Impprtat File/DashBorad Project/.codex-tmp/order-analysis/sample-orders-report.json';
const output = 'C:/Users/shukl/Desktop/Impprtat File/DashBorad Project/.codex-tmp/order-analysis/sample-orders-summary.json';
const report = JSON.parse(await fs.readFile(input, 'utf8'));

const summaries = report.orderReports.map(order => ({
  orderId: order.orderId,
  saleRows: order.saleRows,
  saleQuantity: order.saleQuantity,
  saleTotal: order.saleTotal,
  paymentItemGroups: order.paymentItemGroups,
  paymentLines: order.paymentLines,
  paymentNet: order.paymentNet,
  paymentGrossProduct: order.paymentGrossProduct,
  paymentOrderProduct: order.paymentOrderProduct,
  paymentRefundProduct: order.paymentRefundProduct,
  paymentNetShipping: order.paymentNetShipping,
  paymentOrderCustomerShipping: order.paymentOrderCustomerShipping,
  paymentOrderShippingDiscount: order.paymentOrderShippingDiscount,
  salesToOrderCreditsDelta: order.salesToOrderCreditsDelta,
  fulfillment: order.fulfillment,
  transactionTypes: order.transactionTypes,
  parameters: order.parameters,
  items: order.items.map(item => ({
    sku: item.sku,
    orderItemCode: item.orderItemCode,
    saleSourceRows: item.sale?.sourceRows ?? [],
    orderQuantity: item.orderQuantity,
    fulfillment: item.fulfillment,
    transactionTypes: item.transactionTypes,
    saleTotal: item.sale?.total ?? null,
    productSaleFromPayment: item.totals.productSale,
    orderProductSaleFromPayment: item.totals.orderProductSale,
    refundProductSaleFromPayment: item.totals.refundProductSale,
    orderCustomerShipping: item.totals.orderCustomerShipping,
    orderShippingDiscount: item.totals.orderShippingDiscount,
    netShipping: item.totals.netShipping,
    netSettlement: item.totals.netSettlement,
    tcs: item.totals.tcs,
    tds: item.totals.tds,
    pickPack: item.totals.pickPack,
    weightHandling: item.totals.weightHandling,
    technology: item.totals.technology,
    closing: item.totals.closing,
    commission: item.totals.commission,
    parameters: item.parameterSet,
    otherLines: item.otherLines,
  })),
}));

const paymentItems = summaries.flatMap(order => order.items.map(item => ({ ...item, orderId: order.orderId })));
const frequency = (array, field) => Object.entries(array.reduce((counts, row) => {
  for (const value of row[field] ?? []) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}, {})).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count }));

const summary = {
  sourceCounts: report.found,
  orders: summaries,
  paymentMissing: summaries.filter(order => order.paymentLines === 0).map(order => ({
    orderId: order.orderId, saleRows: order.saleRows, saleQuantity: order.saleQuantity, saleTotal: order.saleTotal,
  })),
  multiItemOrders: summaries.filter(order => order.saleRows > 1).map(order => ({
    orderId: order.orderId, saleRows: order.saleRows, saleQuantity: order.saleQuantity,
    saleTotal: order.saleTotal, paymentItemGroups: order.paymentItemGroups,
  })),
  multiQuantitySaleRows: summaries.flatMap(order => order.items
    .filter(item => (item.orderQuantity ?? 0) > 1)
    .map(item => ({ orderId: order.orderId, sku: item.sku, quantity: item.orderQuantity, orderItemCode: item.orderItemCode }))),
  transactionTypeFrequency: frequency(paymentItems, 'transactionTypes'),
  fulfillmentFrequency: frequency(paymentItems, 'fulfillment'),
  parameterFrequency: frequency(paymentItems, 'parameters'),
  patternGroups: report.patternGroups.map(group => ({
    pattern: group.pattern,
    count: group.items.length,
    examples: group.items.slice(0, 10),
  })),
  paymentItemWithoutSaleRow: report.unmatchedPaymentItems.map(item => ({
    orderId: item.orderId, sku: item.sku, orderItemCode: item.orderItemCode, netSettlement: item.totals.netSettlement,
  })),
  saleRowWithoutPayment: report.unmatchedSaleRows.map(sale => ({
    orderId: sale.orderId, sku: sale.sku, quantity: sale.quantity, total: sale.total, row: sale.row,
  })),
};
await fs.writeFile(output, JSON.stringify(summary, null, 2), 'utf8');
console.log(JSON.stringify({ output, paymentMissing: summary.paymentMissing.length, multiItems: summary.multiItemOrders.length, multiQuantityRows: summary.multiQuantitySaleRows.length, unmatchedPaymentItems: summary.paymentItemWithoutSaleRow.length, unmatchedSales: summary.saleRowWithoutPayment.length }, null, 2));
