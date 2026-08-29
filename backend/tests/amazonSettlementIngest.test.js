import { describe, expect, it, vi } from 'vitest';
import { replaceAmazonSettlement } from '../services/amazonSettlementIngest.js';

function makeDatabase({ failInsert = false } = {}) {
  const calls = [];
  const client = {
    query: vi.fn(async (sql, params = []) => {
      const text = String(sql).trim();
      calls.push({ text, params });
      if (text.startsWith('SELECT DISTINCT order_id')) {
        return { rows: [{ order_id: 'old-order' }], rowCount: 1 };
      }
      if (text.startsWith('DELETE FROM amazon_settlement_lines')) {
        return { rows: [], rowCount: 8 };
      }
      if (text.startsWith('INSERT INTO amazon_settlement_lines')) {
        if (failInsert) throw new Error('insert failed');
        return { rows: [], rowCount: 2 };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  return {
    calls,
    client,
    pool: { connect: vi.fn(async () => client) },
  };
}

const lines = [
  { settlement_id: 'S-1', order_id: 'new-order', amount: 100, marketplace: 'amazon' },
  { settlement_id: 'S-1', order_id: null, amount: -10, marketplace: 'amazon' },
];

describe('Amazon settlement replacement', () => {
  it('locks, removes, and replaces one settlement in a transaction', async () => {
    const db = makeDatabase();
    const result = await replaceAmazonSettlement({
      pool: db.pool,
      settlementId: 'S-1',
      envelope: { sid: 'S-1', totalAmt: 90 },
      filename: 'settlement.csv',
      lines,
    });

    const statements = db.calls.map(call => call.text);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.some(sql => sql.endsWith('FOR UPDATE'))).toBe(true);
    expect(statements.findIndex(sql => sql.startsWith('DELETE FROM amazon_settlement_lines')))
      .toBeLessThan(statements.findIndex(sql => sql.startsWith('INSERT INTO amazon_settlement_lines')));
    expect(statements.at(-1)).toBe('COMMIT');
    expect(result).toMatchObject({ linesInserted: 2, replacedLines: 8 });
    expect(result.affectedOrderIds).toEqual(expect.arrayContaining(['new-order', 'old-order']));
    expect(db.client.release).toHaveBeenCalledOnce();
  });

  it('rolls back and releases the connection if replacement fails', async () => {
    const db = makeDatabase({ failInsert: true });
    await expect(replaceAmazonSettlement({
      pool: db.pool,
      settlementId: 'S-1',
      envelope: null,
      filename: 'settlement.csv',
      lines,
    })).rejects.toThrow('insert failed');

    expect(db.calls.map(call => call.text)).toContain('ROLLBACK');
    expect(db.client.release).toHaveBeenCalledOnce();
  });
});
