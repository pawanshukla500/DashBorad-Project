import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const routeSource = fs.readFileSync(new URL('../routes/amazonUpload.js', import.meta.url), 'utf8');
const schemaSource = fs.readFileSync(new URL('../db/initDb.js', import.meta.url), 'utf8');
const reportingRollupSource = fs.readFileSync(new URL('../services/amazonSettlementReportingRollups.js', import.meta.url), 'utf8');

describe('Amazon performance and report structure', () => {
  it('uses indexed date ranges and applies fulfilment before every pivot aggregate', () => {
    expect(routeSource).not.toContain("TO_CHAR(l.posted_date");
    expect(routeSource).toContain("fulfilment_order.fulfilment_type");
    expect(routeSource).toContain('pool.query(grandSql, params)');
    expect(routeSource).not.toContain('totalCountSql');
  });

  it('prevents SKU fan-out in pivot enrichment', () => {
    expect(routeSource).toContain("MAX(master_sku) FILTER (WHERE marketplace = 'amazon')");
    expect(routeSource).toContain('GROUP BY listing_sku');
  });

  it('keeps multi-SKU Amazon lines separate in the unified ledger', () => {
    expect(schemaSource).toContain('amazonReportingRollupUnifiedSelect()');
    expect(reportingRollupSource).toContain("GROUP BY COALESCE(ord.order_item_id, NULLIF(r.order_item_code, ''), 'AMZ:' || r.order_id || ':' || NULLIF(r.sku, ''))");
    expect(reportingRollupSource).toContain("l.amount_description ILIKE 'Commission%'");
    expect(schemaSource).toContain('IX_amzn_lines_settle_date');
  });

  it('preserves positional columns when an uploaded header row contains blanks', () => {
    expect(routeSource).toContain("const headers = rows[0].map(h => (h + '').trim());");
    expect(routeSource).not.toContain("rows[0].map(h => (h + '').trim()).filter(Boolean)");
  });
});
