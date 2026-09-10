function sanitizeCell(val) {
  if (typeof val === 'string' && /^[=+\-@\t\r]/.test(val)) {
    return `'${val}`;
  }
  return val;
}

// Build a sheet from header + data rows, set column widths, freeze header row
function makeSheet(XLSX, headers, rows, colWidths) {
  const aoa = [headers.map(sanitizeCell), ...rows.map(row => row.map(sanitizeCell))];
  const ws  = XLSX.utils.aoa_to_sheet(aoa);

  // Freeze top row
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  // Column widths
  if (colWidths) {
    ws['!cols'] = colWidths.map(w => ({ wch: w }));
  }

  return ws;
}

// Main export function — receives array of { sheetName, headers, rows, colWidths }
export async function exportXlsx(sheets, filename) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ sheetName, headers, rows, colWidths }) => {
    const ws = makeSheet(XLSX, headers, rows, colWidths);
    XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31)); // Excel max 31 chars
  });
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : filename + '.xlsx');
}

// ─── Page-specific builders ───────────────────────────────────────────────────

export function buildSalesExport(orders, filters) {
  const label = filters?.month ? `_${filters.month}` : '';
  const filename = `Sales${label}_${today()}`;

  const headers = ['Date', 'Order Item ID', 'Category', 'Fulfilment', 'State', 'Qty',
                   'Invoice Amt (₹)', 'My Share (₹)', 'Commission (₹)', 'Settlement (₹)',
                   'Status', 'Return Type'];
  const rows = orders.map(o => [
    o.orderDate, o.orderItemId, o.category, o.fulfilmentType, o.deliveryState,
    o.qty, num(o.finalInvoiceAmount), num(o.myShare), num(o.commission),
    num(o.settlementAmount), o.ordersStatus, o.returnType || '—',
  ]);
  const colWidths = [14, 22, 20, 14, 16, 6, 16, 16, 16, 16, 14, 14];

  return { filename, sheets: [{ sheetName: 'Orders', headers, rows, colWidths }] };
}

export function buildReturnsExport(returns, filters) {
  const label = filters?.month ? `_${filters.month}` : '';
  const filename = `Returns${label}_${today()}`;

  const headers = ['Date', 'Order Item ID', 'Category', 'State', 'Return ID',
                   'Return Status', 'Return Type', 'Return Reason', 'Sub Reason',
                   'Result', 'My Share (₹)'];
  const rows = returns.map(r => {
    // /api/returns returns flattened return fields; retain the nested fallback
    // for callers that provide a richer order-detail object.
    const returnInfo = r.returnInfo || r;
    return [
      r.orderDate, r.orderItemId, r.category, r.deliveryState,
      returnInfo.returnId || '—', returnInfo.returnStatus || '—',
      returnInfo.returnType || '—', returnInfo.returnReason || '—',
      returnInfo.returnSubReason || '—', returnInfo.returnResult || '—',
      num(r.myShare),
    ];
  });
  const colWidths = [14, 22, 20, 16, 20, 16, 16, 24, 24, 16, 16];

  return { filename, sheets: [{ sheetName: 'Returns', headers, rows, colWidths }] };
}

export function buildSettlementExport(orders, filters) {
  const label = filters?.month ? `_${filters.month}` : '';
  const filename = `Flipkart_Settlement${label}_${today()}`;

  const headers = ['Date', 'Order Item ID', 'Category', 'Fulfilment', 'State',
                   'Order Amt (₹)', 'Bank Received (₹)', 'Refund (₹)',
                   'Payment Date', 'Status', 'Return Reason'];
  const rows = orders.map(o => [
    o.orderDate, o.orderItemId, o.category, o.fulfilmentType, o.deliveryState,
    num(o.finalInvoiceAmount), num(o.bankReceived), num(o.refundAmount),
    o.paymentDate || '—', o.settlementStatus, o.returnReason || '—',
  ]);
  const colWidths = [14, 22, 20, 14, 16, 16, 18, 14, 16, 18, 24];

  return { filename, sheets: [{ sheetName: 'Reconciliation', headers, rows, colWidths }] };
}

export function buildProfitLossExport(plData) {
  const filename = `Flipkart_ProfitLoss_${today()}`;
  const { summary = {}, fees = {}, trend = [], byCategory = [] } = plData || {};

  // Sheet 1 – Summary KPIs
  const summaryHeaders = ['Metric', 'Value'];
  const summaryRows = [
    ['Gross Revenue (₹)',       num(summary.grossRevenue)],
    ['Bank Received (₹)',       num(summary.bankReceived)],
    ['Marketplace Deductions (₹)', num(summary.totalDeductions)],
    ['Refund Debited (₹)',      num(summary.refundDebited)],
    ['Net Bank Receipt (₹)',    num(summary.netBank)],
    ['Unsettled Amount (₹)',    num(summary.unsettledAmount)],
    ['Unsettled Orders',        summary.unsettledCount || 0],
    ['Total Orders',            summary.totalOrders || 0],
    ['Total Returns',           summary.returnCount || 0],
    ['Return Rate (%)',         (summary.returnRate || 0).toFixed(1)],
    ['Net Margin (%)',          (summary.marginPct || 0).toFixed(1)],
  ];

  // Sheet 2 – Fee Breakdown
  const feeHeaders = ['Fee Type', 'Amount (₹)'];
  const feeRows = Object.entries(fees).map(([k, v]) => [k, num(v)]);

  // Sheet 3 – Category P&L
  const catHeaders = ['Category', 'Orders', 'Returns', 'Return Rate (%)',
                       'Gross Revenue (₹)', 'Bank Received (₹)', 'Deductions (₹)',
                       'Refund Debited (₹)', 'Net Bank (₹)', 'Margin (%)'];
  const catRows = byCategory.map(c => [
    c.category, c.orders, c.returns, (c.returnRate || 0).toFixed(1),
    num(c.grossRevenue), num(c.bankReceived), num(c.deductions),
    num(c.refundDebited), num(c.netBank), (c.margin || 0).toFixed(1),
  ]);

  // Sheet 4 – Monthly Trend
  const trendHeaders = ['Month', 'Gross Revenue (₹)', 'Bank Received (₹)',
                         'Deductions (₹)', 'Refund Debited (₹)', 'Net Settlement (₹)'];
  const trendRows = trend.map(t => [
    t.month, num(t.grossRevenue), num(t.bankReceived),
    num(t.deductions), num(t.refundDebited), num(t.netSettlement),
  ]);

  return {
    filename,
    sheets: [
      { sheetName: 'Summary',       headers: summaryHeaders, rows: summaryRows,  colWidths: [28, 20] },
      { sheetName: 'Fee Breakdown',  headers: feeHeaders,     rows: feeRows,      colWidths: [28, 20] },
      { sheetName: 'Category P&L',   headers: catHeaders,     rows: catRows,      colWidths: [20,8,8,14,18,18,16,18,16,12] },
      { sheetName: 'Monthly Trend',  headers: trendHeaders,   rows: trendRows,    colWidths: [12,18,18,16,18,20] },
    ],
  };
}

export function buildStatementExport(allData, months, activeMonth) {
  const filename = `Flipkart_Statement_${activeMonth || today()}`;
  const sheets   = [];

  // Sheet per uploaded month
  months.forEach(m => {
    const items = allData.filter(d => d.month === m);
    const headers = ['Description', 'Category', 'Credits (₹)', 'Debits (₹)',
                     'Net Settled Amount (₹)', '% of Sale Amount'];
    const rows = items.map(d => [
      d.description, d.category, num(d.credits), num(d.debits), num(d.net),
      parseFloat(d.pct || 0).toFixed(2) + '%',
    ]);
    sheets.push({ sheetName: m, headers, rows, colWidths: [30, 16, 16, 16, 22, 16] });
  });

  // Comparison sheet (all months side by side)
  if (months.length > 1) {
    const descs = [...new Set(allData.map(d => d.description))];
    const pivot  = {};
    allData.forEach(d => {
      if (!pivot[d.description]) pivot[d.description] = { description: d.description, category: d.category };
      pivot[d.description][d.month] = d.net;
      pivot[d.description][d.month + '_pct'] = d.pct;
    });
    const cmpHeaders = ['Description', 'Category',
      ...months.flatMap(m => [`${m} Net (₹)`, `${m} % of Sale`])];
    const cmpRows = descs.map(desc => {
      const row = pivot[desc] || {};
      return [desc, row.category || '',
        ...months.flatMap(m => [num(row[m] ?? ''), row[m + '_pct'] !== undefined ? parseFloat(row[m + '_pct']).toFixed(2) + '%' : ''])];
    });
    const cmpWidths = [30, 16, ...months.flatMap(() => [18, 14])];
    sheets.push({ sheetName: 'Comparison', headers: cmpHeaders, rows: cmpRows, colWidths: cmpWidths });
  }

  return { filename, sheets };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function today() {
  return new Date().toISOString().slice(0, 10);
}
function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? (v ?? '') : n;
}

export function buildDetailedReportExport(data, month, marketplace) {
  const filename = `Detailed_Report___`;
  const headers = ['Date', 'Order Item ID', 'Category', 'Brand', 'Fulfilment', 'Invoice Amt (Rs)', 'Bank Settlement (Rs)', 'Commission (Rs)', 'Comm Dispute', 'Fixed Fee (Rs)', 'Fixed Dispute', 'Collection Fee (Rs)', 'Pick/Pack (Rs)', 'Shipping (Rs)', 'Rev Shipping (Rs)'];
  const rows = data.map(o => [
    o.order_date, o.order_item_id, o.category, o.brand_name, o.fulfilment_type,
    num(o.final_invoice_amount), num(o.bank_settlement), num(o.commission),
    o.comm_dispute || 'open', num(o.fixed_fee), o.fixed_dispute || 'open',
    num(o.collection_fee), num(o.pick_pack_fee), num(o.shipping_fee), num(o.reverse_shipping)
  ]);
  const colWidths = [14, 22, 20, 20, 14, 16, 20, 16, 14, 16, 14, 16, 16, 16, 16];
  return { filename, sheets: [{ sheetName: 'Details', headers, rows, colWidths }] };
}

// Amazon sends a payment ledger rather than one flat fee row per order. Keeping
// each fee line in the export gives the finance team evidence for a case.
export function buildAmazonPaymentExport(data, month = '') {
  const scope = month || 'all-data';
  const summary = data?.summary || {};
  const feeBreakdown = data?.feeBreakdown || [];
  const caseRows = [];
  const paymentRows = [];

  (data?.rows || []).forEach(order => {
    Object.values(order.fees || {}).forEach(fee => {
      if (!(fee.actualTotal > 0 || fee.credits > 0)) return;
      const row = [
        order.order_id, order.sku || '', order.program || '', order.quantity || 1,
        num(order.sale_amount), num(order.net_settlement), fee.label,
        num(fee.actualBase), num(fee.actualTax), num(fee.credits), num(fee.actualTotal),
        fee.expectedTotal == null ? '' : num(fee.expectedTotal),
        fee.variance == null ? '' : num(fee.variance), fee.status || '',
      ];
      paymentRows.push(row);
      if (fee.status === 'overcharged') caseRows.push(row);
    });
  });

  const paymentHeaders = ['Order ID', 'SKU', 'Program', 'Qty', 'Sale value (Rs)', 'Net settled (Rs)', 'Fee parameter', 'Actual base (Rs)', 'GST (Rs)', 'Credits (Rs)', 'Actual fee (Rs)', 'Expected fee (Rs)', 'Variance (Rs)', 'Status'];
  const paymentWidths = [23, 22, 12, 8, 16, 16, 31, 16, 12, 13, 16, 16, 16, 20];
  return {
    filename: `Amazon_Payment_Check_${scope}_${today()}`,
    sheets: [
      {
        sheetName: 'Summary',
        headers: ['Metric', 'Value'],
        rows: [
          ['Settlement scope', scope], ['Sale value (Rs)', num(summary.grossSales)],
          ['Actual fee charges (Rs)', num(summary.actualFees)], ['Expected charges (Rs)', num(summary.expectedFees)],
          ['Potential overcharge (Rs)', num(summary.potentialOvercharge)], ['Configured comparisons', summary.configuredComparisons || 0],
          ['Charges needing a verified rate', summary.unconfiguredCharges || 0], ['Return lines held for review', summary.refundLines || 0],
          ['Export note', 'Return credits are separate from sale-fee comparisons. This export contains the payment lines currently shown in the payment check.'],
        ],
        colWidths: [36, 98],
      },
      {
        sheetName: 'Fee Parameters',
        headers: ['Fee parameter', 'Actual base (Rs)', 'GST (Rs)', 'Credits (Rs)', 'Net charged (Rs)', 'Expected (Rs)', 'Variance (Rs)', 'Configured lines', 'Charge lines'],
        rows: feeBreakdown.map(fee => [fee.label, num(fee.actualBase), num(fee.actualTax), num(fee.credits), num(fee.actualTotal), fee.configuredLines ? num(fee.expectedTotal) : '', fee.configuredLines ? num(fee.variance) : '', fee.configuredLines || 0, fee.chargeLines || 0]),
        colWidths: [32, 18, 14, 14, 18, 16, 16, 18, 14],
      },
      { sheetName: 'Potential Fee Leaks', headers: paymentHeaders, rows: caseRows, colWidths: paymentWidths },
      { sheetName: 'Payment Evidence', headers: paymentHeaders, rows: paymentRows, colWidths: paymentWidths },
    ],
  };
}
