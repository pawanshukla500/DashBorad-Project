import { describe, expect, it, vi } from 'vitest';
import {
  SOR_AJIO_LINE_SOURCE,
  buildAjioSorInvoices,
  mirrorAjioInvoicesToSor,
  rebuildAjioSorLedger,
} from '../services/sorMirror.js';

/**
 * AJIO → SOR ledger mirror.
 *
 * The ledger is rebuilt from the persisted mp_invoices rows, so the stub pool
 * answers the mp_invoices / orders reads from fixtures and records every
 * statement the per-invoice transactions send on the dedicated client.
 */

function storedRow(overrides = {}) {
  return {
    id: 1,
    seller_account: 'ajio_main',
    invoice_number: 'AJ-001',
    invoice_date: '2026-09-10',
    sku: 'SKU-A',
    quantity: 1,
    invoice_amount: '1000.00',
    commission_amount: '150.00',
    other_deductions: '20.00',
    tcs_amount: null,
    tds_amount: '10.00',
    net_payable: '820.00',
    amount_received: '0.00',
    payment_date: null,
    payment_reference: null,
    order_release_id: null,
    order_line_id: null,
    return_id: null,
    order_type: null,
    ...overrides,
  };
}

function makePool({ stored = [], orders = [], existingHeaders = new Map(), failOn = null } = {}) {
  const statements = [];
  let nextId = 40;
  const client = {
    query: vi.fn(async (sql, params = []) => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      statements.push({ text, params });
      if (failOn && text.startsWith('INSERT INTO sor_invoice ') && params[2] === failOn) {
        throw new Error('simulated write failure');
      }
      if (text.startsWith('INSERT INTO sor_invoice ')) return { rows: [{ id: ++nextId }] };
      if (text.startsWith('SELECT id FROM sor_invoice')) {
        const id = existingHeaders.get(`${params[1]}|${params[2]}`);
        return { rows: id ? [{ id }] : [] };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async (sql, params = []) => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      statements.push({ text, params, viaPool: true });
      if (text.includes('FROM mp_invoices m')) {
        const [accounts, invoiceNos] = params;
        const keys = new Set(accounts.map((account, i) => `${account}|${invoiceNos[i]}`));
        return { rows: stored.filter(row => keys.has(`${row.seller_account}|${row.invoice_number}`)) };
      }
      if (text.includes('FROM orders')) return { rows: orders };
      if (text.includes('UNION')) {
        const keys = new Map();
        for (const row of stored) keys.set(`${row.seller_account}|${row.invoice_number}`, { seller_account: row.seller_account, invoice_no: row.invoice_number });
        for (const key of existingHeaders.keys()) {
          const [seller_account, invoice_no] = key.split('|');
          keys.set(key, { seller_account, invoice_no });
        }
        return { rows: [...keys.values()] };
      }
      return { rows: [] };
    }),
    connect: vi.fn(async () => client),
  };
  return { pool, client, statements };
}

describe('buildAjioSorInvoices — aggregation', () => {
  it('collapses rows of one invoice into a header whose net_payable is what AJIO declared', () => {
    const invoices = buildAjioSorInvoices([
      storedRow({ id: 1 }),
      storedRow({ id: 2, sku: 'SKU-B', invoice_amount: '500', commission_amount: '75', other_deductions: '0', tds_amount: '5', net_payable: '419' }),
    ]);
    expect(invoices.size).toBe(1);
    const [invoice] = invoices.values();
    expect(invoice).toMatchObject({
      portal_account: 'ajio_main',
      invoice_no: 'AJ-001',
      gross_amount: 1500,
      fee_amount: 245,
      tds_amount: 15,
      net_payable: 1239,
      mp_invoice_ids: [1, 2],
    });
  });

  it('keeps invoices of different seller accounts apart', () => {
    const invoices = buildAjioSorInvoices([
      storedRow({ id: 1, seller_account: 'ajio_a' }),
      storedRow({ id: 2, seller_account: 'ajio_b' }),
    ]);
    expect(invoices.size).toBe(2);
  });

  it('emits one sale line per row plus one deduction line per non-zero fee', () => {
    const [invoice] = buildAjioSorInvoices([storedRow({ tcs_amount: '2.5' })]).values();
    const shape = invoice.lines.map(line => [line.line_type, line.gross_amount, line.raw_payload.fee_type ?? null]);
    expect(shape).toEqual([
      ['sale', 1000, null],
      ['deduction', 150, 'commission'],
      ['deduction', 20, 'other_deductions'],
      ['deduction', 2.5, 'tcs'],
      ['deduction', 10, 'tds'],
    ]);
    expect(invoice.fee_amount).toBe(172.5);
  });

  it('keys every line for idempotent re-syncs and folds one UTR across SKU rows into one payment', () => {
    const [invoice] = buildAjioSorInvoices([
      storedRow({ id: 1, amount_received: '410', payment_reference: 'utr 77', payment_date: '2026-09-25' }),
      storedRow({ id: 2, sku: 'SKU-B', amount_received: '410', payment_reference: 'UTR77', payment_date: '2026-09-25' }),
    ]).values();
    const payments = invoice.lines.filter(line => line.line_type === 'payment');
    expect(payments).toEqual([expect.objectContaining({ source_key: 'pay:UTR77', gross_amount: 820, line_date: '2026-09-25', description: 'Payment' })]);
    expect(invoice.lines.find(line => line.line_type === 'deduction').source_key).toBe('mp:1:commission');
    expect(new Set(invoice.lines.map(line => `${line.line_type}:${line.source_key}`)).size).toBe(invoice.lines.length);
  });

  it('turns amount_received into a payment line so outstanding drops once AJIO pays', () => {
    const [invoice] = buildAjioSorInvoices([
      storedRow({ amount_received: '820', payment_date: '2026-09-25', payment_reference: 'UTR123' }),
    ]).values();
    const payment = invoice.lines.find(line => line.line_type === 'payment');
    expect(payment.gross_amount).toBe(820);
    expect(payment.raw_payload).toMatchObject({ payment_date: '2026-09-25', payment_reference: 'UTR123' });
  });

  it('books reverse rows as return lines and keeps negative fee reversals signed', () => {
    const [invoice] = buildAjioSorInvoices([
      storedRow({ invoice_amount: '-400', commission_amount: '-60', other_deductions: '0', tds_amount: '-4', net_payable: '-336' }),
    ]).values();
    expect(invoice.lines.map(line => [line.line_type, line.gross_amount])).toEqual([
      ['return', 400],
      ['deduction', -60],
      ['deduction', -4],
    ]);
    // Same math as the header: -400 gross, -60 fee, -4 TDS.
    expect(invoice).toMatchObject({ gross_amount: -400, fee_amount: -60, tds_amount: -4, net_payable: -336 });
  });

  it('treats a positive-amount row with a Return ID as a full reversal (fees and net flip sign)', () => {
    const [invoice] = buildAjioSorInvoices([
      storedRow({ return_id: 'RET-9', invoice_amount: '1000', commission_amount: '100', other_deductions: '0', tds_amount: '10', net_payable: '890' }),
    ]).values();
    expect(invoice.lines.map(line => [line.line_type, line.gross_amount])).toEqual([
      ['return', 1000],
      ['deduction', -100],
      ['deduction', -10],
    ]);
    // The ledger drops by the net (1000 − 110 = 890), matching AJIO's declared net.
    expect(invoice).toMatchObject({ gross_amount: -1000, fee_amount: -100, tds_amount: -10, net_payable: -890 });
  });

  it('links lines to orders by order line / release id, never by invoice number', () => {
    const orderRowIds = new Map([['OL-7', 701]]);
    const [invoice] = buildAjioSorInvoices([
      storedRow({ order_line_id: 'OL-7', order_release_id: 'OR-7' }),
    ], orderRowIds).values();
    expect(invoice.lines.every(line => line.order_id === 'OL-7' && line.order_row_id === 701)).toBe(true);
  });

  it('spans period_from / period_to over the row dates and uses the earliest as invoice_date', () => {
    const [invoice] = buildAjioSorInvoices([
      storedRow({ id: 1, invoice_date: '2026-09-12' }),
      storedRow({ id: 2, invoice_date: '2026-09-03' }),
    ]).values();
    expect(invoice).toMatchObject({ invoice_date: '2026-09-03', period_from: '2026-09-03', period_to: '2026-09-12' });
  });
});

describe('mirrorAjioInvoicesToSor — persistence', () => {
  it('does nothing for an empty key list', async () => {
    const { pool } = makePool();
    const result = await mirrorAjioInvoicesToSor(pool, []);
    expect(result).toEqual({ mirrored: 0, removed: 0, errors: [] });
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('re-reads stored rows for the touched invoices and dedupes repeated keys', async () => {
    const { pool, statements } = makePool({ stored: [storedRow()] });
    await mirrorAjioInvoicesToSor(pool, [
      { seller_account: 'ajio_main', invoice_no: 'AJ-001' },
      { seller_account: 'ajio_main', invoice_no: 'AJ-001' },
      { seller_account: '', invoice_no: 'AJ-002' },
    ]);
    const read = statements.find(s => s.text.includes('FROM mp_invoices m'));
    expect(read.text).toContain("m.marketplace = 'ajio'");
    expect(read.params).toEqual([['ajio_main'], ['AJ-001']]);
  });

  it('writes header + lines in one transaction on one client and replaces only mirror-owned lines', async () => {
    const { pool, client, statements } = makePool({ stored: [storedRow()] });
    const result = await mirrorAjioInvoicesToSor(pool, [{ seller_account: 'ajio_main', invoice_no: 'AJ-001' }], { uploadedBy: 'ops@example.com' });
    expect(result).toEqual({ mirrored: 1, removed: 0, errors: [] });
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);

    const tx = statements.filter(s => !s.viaPool).map(s => s.text.split(' ').slice(0, 3).join(' '));
    expect(tx).toEqual([
      'BEGIN',
      'INSERT INTO sor_invoice',
      'DELETE FROM sor_invoice_line',
      'SELECT invoice_id, line_type,', // components SOR uploads already own
      'INSERT INTO sor_invoice_line',
      'COMMIT',
    ]);
    const header = statements.find(s => s.text.startsWith('INSERT INTO sor_invoice '));
    expect(header.params.slice(0, 3)).toEqual(['reliance-ajio', 'ajio_main', 'AJ-001']);
    expect(header.params[10]).toBe(820); // declared net_payable
    expect(header.params[12]).toBe('ops@example.com');
    const remove = statements.find(s => s.text.startsWith('DELETE FROM sor_invoice_line'));
    expect(remove.text).toContain('AND source = $2');
    expect(remove.params[1]).toBe(SOR_AJIO_LINE_SOURCE);
    const insert = statements.find(s => s.text.startsWith('INSERT INTO sor_invoice_line'));
    expect(insert.params).toHaveLength(4 * 16); // sale + 3 deductions, 16 columns each
    expect(insert.params[11]).toBe(SOR_AJIO_LINE_SOURCE);
    expect(insert.params.slice(12, 16)).toEqual(['mp:1', '2026-09-10', 'AJ-001', 'Invoice']);
    expect(insert.text).toContain('$11::jsonb');
    expect(insert.text).toContain('ON CONFLICT (invoice_id, line_type, source_key) DO NOTHING');
  });

  it('removes the mirrored lines and the emptied header when the AJIO rows are gone', async () => {
    const { pool, statements } = makePool({ existingHeaders: new Map([['ajio_main|AJ-OLD', 77]]) });
    const result = await mirrorAjioInvoicesToSor(pool, [{ seller_account: 'ajio_main', invoice_no: 'AJ-OLD' }]);
    expect(result).toEqual({ mirrored: 0, removed: 1, errors: [] });
    const deletes = statements.filter(s => s.text.startsWith('DELETE'));
    expect(deletes[0].text).toContain('AND source = $2');
    expect(deletes[1].text).toContain('NOT EXISTS (SELECT 1 FROM sor_invoice_line');
  });

  it('rolls back a failing invoice, reports it, and still commits the others', async () => {
    const { pool, client, statements } = makePool({
      stored: [storedRow({ id: 1, invoice_number: 'AJ-BAD' }), storedRow({ id: 2, invoice_number: 'AJ-OK' })],
      failOn: 'AJ-BAD',
    });
    const result = await mirrorAjioInvoicesToSor(pool, [
      { seller_account: 'ajio_main', invoice_no: 'AJ-BAD' },
      { seller_account: 'ajio_main', invoice_no: 'AJ-OK' },
    ]);
    expect(result.mirrored).toBe(1);
    expect(result.errors).toEqual([expect.stringContaining('AJ-BAD')]);
    const control = statements.filter(s => ['BEGIN', 'ROLLBACK', 'COMMIT'].includes(s.text)).map(s => s.text);
    expect(control).toEqual(['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('resolves order rows against AJIO orders only', async () => {
    const { pool, statements } = makePool({
      stored: [storedRow({ order_line_id: 'OL-7' })],
      orders: [{ id: 701, order_item_id: 'OL-7', order_id: 'OR-7' }],
    });
    await mirrorAjioInvoicesToSor(pool, [{ seller_account: 'ajio_main', invoice_no: 'AJ-001' }]);
    const lookup = statements.find(s => s.text.includes('FROM orders'));
    expect(lookup.text).toContain("marketplace = 'ajio'");
    const insert = statements.find(s => s.text.startsWith('INSERT INTO sor_invoice_line'));
    expect(insert.params[9]).toBe(701); // order_row_id of the sale line
  });
});

describe('rebuildAjioSorLedger', () => {
  it('syncs every stored AJIO invoice and every existing mirrored header', async () => {
    const { pool } = makePool({
      stored: [storedRow({ invoice_number: 'AJ-001' })],
      existingHeaders: new Map([['ajio_main|AJ-CLEARED', 90]]),
    });
    const result = await rebuildAjioSorLedger(pool);
    expect(result).toEqual({ mirrored: 1, removed: 1, errors: [] });
  });
});
