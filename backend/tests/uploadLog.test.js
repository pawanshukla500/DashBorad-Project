import { describe, expect, it, vi } from 'vitest';
import { getUploadHistory, saveSkippedRows } from '../services/uploadLog.js';

describe('upload history service', () => {
  it('returns paginated file history with server-side filters', async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [{
          id: 9,
          data_type: 'amazon_settlement',
          filename: 'settlement.csv',
          marketplace: 'amazon',
          rows_inserted: '4500',
          rows_updated: '0',
          rows_skipped: '2',
          status: 'ok',
          error_msg: null,
          remark: 'July report',
          uploaded_at: '2026-08-06T10:00:00.000Z',
          total_count: '27',
        }],
      })),
    };

    const result = await getUploadHistory(pool, {
      page: '2',
      pageSize: '10',
      marketplace: 'amazon',
      status: 'ok',
      search: 'settlement',
    });

    expect(result.pagination).toEqual({ page: 2, pageSize: 10, total: 27 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).not.toHaveProperty('total_count');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('COUNT(*) OVER () AS total_count');
    expect(sql).toContain('filename ILIKE');
    expect(params).toEqual(['amazon', 'ok', '%settlement%', 10, 10]);
  });

  it('stores skipped-row details in 5,000-row chunks', async () => {
    const pool = { query: vi.fn(async () => ({ rowCount: 0 })) };
    const skippedRows = Array.from({ length: 5001 }, (_, index) => ({
      rowNum: index + 2,
      reason: 'Missing ID',
      data: { index },
    }));

    await saveSkippedRows(pool, 42, skippedRows);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[0][1]).toHaveLength(5000 * 4);
    expect(pool.query.mock.calls[1][1]).toHaveLength(4);
  });

  it('can filter retained upload records whose business data was cleared', async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [{
          id: 11,
          data_type: 'myntra_vb_orders',
          filename: 'Myntra Order Layout.xlsx',
          marketplace: 'myntra',
          rows_inserted: 30549,
          rows_updated: 0,
          rows_skipped: 0,
          status: 'ok',
          error_msg: null,
          remark: 'Wrong account file',
          uploaded_at: '2026-08-18T08:00:00.000Z',
          data_cleared_at: '2026-08-18T09:00:00.000Z',
          clear_reason: 'Re-upload under the correct account',
          total_count: '1',
        }],
      })),
    };

    const result = await getUploadHistory(pool, { status: 'cleared' });

    expect(result.rows[0].data_cleared_at).toBe('2026-08-18T09:00:00.000Z');
    expect(result.rows[0].clear_reason).toBe('Re-upload under the correct account');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('data_cleared_at IS NOT NULL');
    expect(params).toEqual([25, 0]);
  });
});
