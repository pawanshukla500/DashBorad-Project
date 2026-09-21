import { describe, expect, it } from 'vitest';
import { myntraInvoicesUnifiedSelect } from '../services/myntraSettlementReportingRollups.js';

// Count output columns of a SELECT by splitting the projection on top-level
// commas (ignoring comments, string literals, and nested parentheses).
function countSelectColumns(sql) {
  const selectList = sql.slice(sql.indexOf('SELECT') + 6, sql.indexOf('FROM mp_invoices'));
  let depth = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  const parts = [];
  let current = '';
  for (let i = 0; i < selectList.length; i++) {
    const char = selectList[i];
    const next = selectList[i + 1];
    if (inLineComment) { if (char === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (char === '*' && next === '/') { inBlockComment = false; i++; } continue; }
    if (char === '-' && next === '-') { inLineComment = true; continue; }
    if (char === '/' && next === '*') { inBlockComment = true; continue; }
    if (char === "'") { inString = !inString; continue; }
    if (inString) continue;
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += char;
  }
  parts.push(current);
  return parts.filter(part => part.trim() !== '').length;
}

describe('Myntra unified_settlements branch', () => {
  const sql = myntraInvoicesUnifiedSelect();

  it('matches the unified_settlements column list exactly', () => {
    // The Flipkart branch defines the view's columns; every UNION branch must
    // line up positionally or the whole dashboard misreads its money columns.
    // 69th column: seller_account (appended so EJ/VB can be filtered).
    expect(countSelectColumns(sql)).toBe(69);
    expect(sql).toMatch(/,\s*i\.seller_account\s+FROM mp_invoices i/);
  });

  it('maps payments onto the shared order reconciliation model', () => {
    // Payments join orders by Order Release ID / Order Line ID.
    expect(sql).toContain("i.order_release_id");
    expect(sql).toContain("i.order_line_id");
    expect(sql).toContain("o.order_item_id = i.order_line_id");
    // Refunded principal is reported through the negative `refund` column and
    // kept out of bank_settlement, matching the Flipkart convention
    // (netBank = SUM(bank) - ABS(SUM(refund))).
    expect(sql).toMatch(/SUM\(CASE WHEN .* = 'reverse' THEN i\.invoice_amount ELSE 0 END\) AS refund/);
    expect(sql).toMatch(/SUM\(i\.amount_received\)/);
    expect(sql).toContain("'myntra'::text");
    expect(sql).toContain('ABS(SUM(i.commission_amount)) AS commission');
    expect(sql).toContain('ABS(SUM(i.tds_amount)) AS tds');
    // Itemized GST-free fee components replace the old other_deductions blob.
    expect(sql).toContain('ABS(SUM(COALESCE(i.tcs_amount, 0))) AS tcs');
    expect(sql).toContain('AS fixed_fee');
    expect(sql).toContain('AS reverse_shipping');
    expect(sql).toContain('ABS(SUM(COALESCE(i.gst_on_mp_fees, 0))) AS gst_on_mp_fees');
    expect(sql).toContain('ABS(SUM(COALESCE(i.gateway_fee_amount, 0))) AS mp_other_fee');
  });

  it('keeps one reporting row per order line and payment date, excluding NOD rows', () => {
    expect(sql).toContain("COALESCE(i.order_type, '') <> 'nod'");
    expect(sql).toMatch(/GROUP BY .*order_line_id, i\.payment_date/);
    expect(sql).toContain('AND i.order_release_id IS NOT NULL');
  });

  it('is unioned into the unified_settlements view on boot', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = new URL('../db/initDb.js', import.meta.url);
    // Windows checkouts (core.autocrlf) use CRLF; the assertion is about content.
    const source = (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
    expect(source).toContain('UNION ALL\n${myntraInvoicesUnifiedSelect()}');
    // The order_type migration runs on already-current installations too.
    expect(source).toContain('await ensureMyntraOrderTypeSchema(pool);');
  });

  it('refreshes the per-order settlement read model after a Myntra payment import', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = new URL('../routes/mpSettlement.js', import.meta.url);
    const source = await readFile(path, 'utf8');
    expect(source).toContain("if (mp === 'myntra' && (inserted || updated))");
    expect(source).toContain('await refreshOrderSettlementTotals(pool)');
  });
});
