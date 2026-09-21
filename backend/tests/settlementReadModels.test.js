import { describe, expect, it, vi } from 'vitest';
import {
  ORDER_SETTLEMENT_TOTALS_LOCK_KEY,
  ORDER_SETTLEMENT_TOTALS_SELECT,
  refreshOrderSettlementTotals,
} from '../services/orderSettlementTotals.js';
import { amazonReportingRollupUnifiedSelect } from '../services/amazonSettlementReportingRollups.js';
import { SETT_CTE } from '../services/settlementSql.js';

function recordingQueryable(results = {}) {
  const statements = [];
  const query = vi.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    statements.push({ text, params });
    const match = Object.entries(results).find(([prefix]) => text.startsWith(prefix));
    if (match && match[1] instanceof Error) throw match[1];
    return match ? match[1] : { rowCount: 0 };
  });
  return { query, statements };
}

describe('settlement reporting read models', () => {
  it('serializes rebuilds, builds the model once and writes only changed rows', async () => {
    const { query, statements } = recordingQueryable({
      'CREATE TEMP TABLE': { rowCount: 42 },
      'DELETE FROM order_settlement_totals': { rowCount: 2 },
      'INSERT INTO order_settlement_totals': { rowCount: 5 },
    });

    await expect(refreshOrderSettlementTotals({ query })).resolves.toEqual({ rowsRefreshed: 42, rowsChanged: 7 });

    const texts = statements.map(statement => statement.text);
    expect(texts[0]).toBe('SELECT pg_advisory_xact_lock($1)');
    expect(statements[0].params).toEqual([ORDER_SETTLEMENT_TOTALS_LOCK_KEY]);
    const create = texts.find(text => text.startsWith('CREATE TEMP TABLE order_settlement_totals_next ON COMMIT DROP'));
    expect(create).toContain('FROM unified_settlements');
    expect(create).toContain('GROUP BY order_item_id');
    expect(texts).toContain('ANALYZE order_settlement_totals_next');
    const remove = texts.find(text => text.startsWith('DELETE FROM order_settlement_totals'));
    expect(remove).toContain('WHERE NOT EXISTS');
    const upsert = texts.find(text => text.startsWith('INSERT INTO order_settlement_totals'));
    expect(upsert).toContain('ON CONFLICT (order_item_id) DO UPDATE SET');
    expect(upsert).toContain('IS DISTINCT FROM');
    // Every stored metric is compared and updated, so the end state equals a full rebuild.
    for (const column of ['net_bank', 'refund_amount', 'payment_date', 'settled_row_count', 'gst_on_mp_fees']) {
      expect(upsert).toContain(`${column} = EXCLUDED.${column}`);
      expect(upsert).toContain(`EXCLUDED.${column}`);
    }
    // The lock precedes every write.
    expect(texts.indexOf(create)).toBeGreaterThan(0);
  });

  it('opens and commits a transaction when called with a pool', async () => {
    const { query, statements } = recordingQueryable({ 'CREATE TEMP TABLE': { rowCount: 7 } });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) };

    await expect(refreshOrderSettlementTotals(pool)).resolves.toMatchObject({ rowsRefreshed: 7 });
    expect(statements[0].text).toBe('BEGIN');
    expect(statements[1].text).toBe('SELECT pg_advisory_xact_lock($1)');
    expect(statements.at(-1).text).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rolls back and releases its connection when the rebuild fails', async () => {
    const { query, statements } = recordingQueryable({ 'CREATE TEMP TABLE': new Error('statement timeout') });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) };

    await expect(refreshOrderSettlementTotals(pool)).rejects.toThrow('statement timeout');
    expect(statements.at(-1).text).toBe('ROLLBACK');
    expect(statements.some(statement => statement.text.startsWith('DELETE FROM order_settlement_totals'))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('keeps CTE consumers on the compact per-order source', () => {
    expect(SETT_CTE).toContain('SELECT * FROM order_settlement_totals');
    expect(ORDER_SETTLEMENT_TOTALS_SELECT).toContain('GROUP BY order_item_id');
    expect(ORDER_SETTLEMENT_TOTALS_SELECT).toContain('AS negative_bank_amount');
  });

  it('re-applies signed Amazon fee netting at the historic order/day grain', () => {
    const sql = amazonReportingRollupUnifiedSelect();
    expect(sql).toContain('ABS(SUM(r.tcs)) AS tcs');
    expect(sql).toContain('ABS(SUM(r.mp_other_fee)) AS mp_other_fee');
    expect(sql).toContain('GROUP BY COALESCE(ord.order_item_id');
  });
});
