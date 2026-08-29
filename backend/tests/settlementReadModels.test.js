import { describe, expect, it, vi } from 'vitest';
import {
  ORDER_SETTLEMENT_TOTALS_SELECT,
  refreshOrderSettlementTotals,
} from '../services/orderSettlementTotals.js';
import { amazonReportingRollupUnifiedSelect } from '../services/amazonSettlementReportingRollups.js';
import { SETT_CTE } from '../services/settlementSql.js';

describe('settlement reporting read models', () => {
  it('refreshes the compact totals with a reader-friendly transactional delete/insert', async () => {
    const query = vi.fn(async () => ({ rowCount: 42 }));
    await expect(refreshOrderSettlementTotals({ query })).resolves.toEqual({ rowsRefreshed: 42 });

    expect(query.mock.calls[0][0]).toContain('DELETE FROM order_settlement_totals');
    expect(query.mock.calls[1][0]).toContain('INSERT INTO order_settlement_totals');
    expect(query.mock.calls[1][0]).toContain('FROM unified_settlements');
  });

  it('opens and commits a transaction when called with a pool', async () => {
    const statements = [];
    const client = {
      query: vi.fn(async sql => {
        statements.push(String(sql).trim());
        return { rowCount: 7 };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };

    await expect(refreshOrderSettlementTotals(pool)).resolves.toEqual({ rowsRefreshed: 7 });
    expect(statements[0]).toBe('BEGIN');
    expect(statements.some(sql => sql.startsWith('DELETE FROM order_settlement_totals'))).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
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
