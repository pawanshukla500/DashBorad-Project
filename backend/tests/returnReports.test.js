import { describe, expect, it, vi } from 'vitest';
import {
  getReturnsTracker,
  getSpfTracking,
  markSpfReceived,
} from '../services/returnReports.js';

describe('return report service', () => {
  it('parameterizes marketplace and reads SPF receipt state from tracking', async () => {
    const marketplace = "amazon' OR 1=1 --";
    const pool = {
      query: vi.fn(async (sql) => sql.startsWith('SELECT COUNT')
        ? { rows: [{ cnt: '1' }] }
        : { rows: [{ order_item_id: 'item-1' }] }),
    };

    const result = await getReturnsTracker(pool, {
      filter: 'spf-pending',
      marketplace,
      page: 2,
      pageSize: 25,
      offset: 25,
    });

    expect(result.total).toBe(1);
    const [dataSql, dataValues] = pool.query.mock.calls[0];
    const [countSql, countValues] = pool.query.mock.calls[1];
    expect(dataSql).not.toContain(marketplace);
    expect(countSql).not.toContain(marketplace);
    expect(dataValues).toEqual([marketplace, 25, 25]);
    expect(countValues).toEqual([marketplace]);
    expect(dataSql).toContain('COALESCE(r.spf_received, FALSE)');
    expect(dataSql).toContain('COALESCE(ost.spf_received, FALSE) = FALSE');
  });

  it('uses the current SPF schema and aggregates settlement rows per order', async () => {
    const pool = {
      query: vi.fn(async (sql) => sql.includes('SELECT COUNT(*) AS cnt')
        ? { rows: [{ cnt: '2' }] }
        : { rows: [] }),
    };

    await getSpfTracking(pool, { page: 1, pageSize: 50, offset: 0 });
    const dataSql = pool.query.mock.calls[0][0];
    expect(dataSql).toContain('ost.spf_received');
    expect(dataSql).not.toMatch(/\bost\.sp_received\b/);
    expect(dataSql).toContain('GROUP BY order_item_id');
  });

  it('reports only rows actually updated by bulk SPF marking', async () => {
    const pool = { query: vi.fn(async () => ({ rowCount: 1, rows: [{ order_item_id: 'item-1' }] })) };
    const updated = await markSpfReceived(pool, {
      orderItemIds: ['item-1', 'item-1', 'missing-item'],
      receivedAmount: 100,
    });

    expect(updated).toBe(1);
    expect(pool.query.mock.calls[0][1][0]).toEqual(['item-1', 'missing-item']);
  });
});
