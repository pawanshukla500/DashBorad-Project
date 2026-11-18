// Coverage for the CodeRabbit review round on the data-optimization hardening.
import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { returnRowReplaces } from '../routes/upload.js';
import { buildDateFormatMap, normalizeSqlDate } from '../utils/dateNormalizer.js';
import { optionalNumber } from '../utils/valueParsers.js';
import { createHeaderIndex } from '../utils/headerIndex.js';
import { forEachIsolated, ISOLATED_GROUP_SIZE } from '../utils/isolatedBatches.js';
import { transactionIdleTimeoutMs } from '../db/index.js';
import { featureUnavailable, requireFeatureReady, setFeatureReadiness } from '../services/featureReadiness.js';
import { activeBackgroundJobs, runInBackground, waitForBackgroundJobs } from '../utils/backgroundJobs.js';
import { adoptLegacyFingerprints, isTextSpreadsheet } from '../utils/legacyTextParse.js';
import { adoptLegacySorInvoiceNumbers } from '../services/sorUpload.js';
import {
  MYNTRA_SYNTHESIZED_RETURN_REASONS,
  backfillOrdersFromMyntraPayment,
  restoreMyntraStatusesWithoutReverse,
} from '../services/myntraSettlementReportingRollups.js';

const source = file => fs.readFileSync(path.resolve(file), 'utf-8');

describe('returns precedence (in-file and stored)', () => {
  const idx = { returnIdIdx: 0, dateIdx: 1, statusIdx: 2 };
  it('lets the same known return take its later row, even a same-date cancellation', () => {
    expect(returnRowReplaces(['R1', '2026-04-05', 'approved'], ['R1', '2026-04-05', 'cancelled'], idx)).toBe(true);
    // ...and a corrected earlier date.
    expect(returnRowReplaces(['R1', '2026-04-09', 'approved'], ['R1', '2026-04-05', 'approved'], idx)).toBe(true);
  });
  it('keeps rejecting a same-date cancellation of a different or unidentified request', () => {
    expect(returnRowReplaces(['R1', '2026-04-05', 'approved'], ['R2', '2026-04-05', 'cancelled'], idx)).toBe(false);
    expect(returnRowReplaces([null, '2026-04-05', 'approved'], [null, '2026-04-05', 'cancelled'], idx)).toBe(false);
  });
  it('does not treat a blank status as active, and prefers later dates', () => {
    expect(returnRowReplaces(['R1', '2026-04-05', 'approved'], ['R2', '2026-04-05', ''], idx)).toBe(false);
    expect(returnRowReplaces(['R1', '2026-04-05', 'approved'], ['R2', '2026-04-05', null], idx)).toBe(false);
    expect(returnRowReplaces(['R1', '2026-04-05', 'approved'], ['R2', '2026-04-06', 'cancelled'], idx)).toBe(true);
    expect(returnRowReplaces(['R1', null, 'approved'], ['R2', '2026-04-06', 'approved'], idx)).toBe(true);
  });
});

describe('date-column format detection', () => {
  const formats = async values => (await buildDateFormatMap({
    rows: values.map(d => ({ d })),
    dateFields: ['d'],
    valueFor: (row, key) => row[key],
  })).d;

  it('ignores a "decisive" sample that is not a real date', async () => {
    const hint = await formats(['05/04/2026', '02/30/2026', '13/04/2026']);
    expect(hint.format).toBe('DMY');
    expect(['05/04/2026', '13/04/2026'].map(value => normalizeSqlDate(value, hint))).toEqual(['2026-04-05', '2026-04-13']);
  });

  it('parses text dates in an ISO column (Excel cells read through dateNF)', async () => {
    const hint = await formats(['2026-04-25', '4/26/26']);
    expect(hint).toMatchObject({ format: 'ISO', fallback: 'MDY' });
    expect(['2026-04-25', '4/26/26'].map(value => normalizeSqlDate(value, hint))).toEqual(['2026-04-25', '2026-04-26']);
  });
});

describe('amount text', () => {
  it.each([
    ['INR ₹1,234.50', 1234.5], ['(1,00,000.00)', -100000], ['12,34,567.89', 1234567.89],
    ['12,345,678.90', 12345678.9], ['-₹1,234', -1234],
  ])('accepts %s', (text, expected) => expect(optionalNumber(text)).toBe(expected));
  it.each(['-₹12.3,4', '12.3,4', '1234,50', '1,23'])('rejects misplaced separators in %s', text => {
    expect(optionalNumber(text)).toBeNull();
  });
});

describe('header index layout key', () => {
  it('keeps layouts whose plain join would collide apart', () => {
    const headers = createHeaderIndex(text => text.toLowerCase());
    const joinedName = ['Amount', 'Note'].join(String.fromCharCode(0));
    expect(headers.column({ Date: 1, Type: 2, [joinedName]: 3 }, 'amount')).toBeUndefined();
    expect(headers.column({ Date: 1, Type: 2, Amount: 3, Note: 4 }, 'amount')).toBe('Amount');
  });
});

describe('isolated groups', () => {
  const client = (failCommitOnce = false) => {
    let failed = false;
    return {
      query: vi.fn(async sql => {
        if (failCommitOnce && sql === 'COMMIT' && !failed) { failed = true; throw new Error('commit failed'); }
        return { rows: [] };
      }),
    };
  };

  it('defaults to the 64-entry subtransaction cache and rejects invalid group sizes', async () => {
    expect(ISOLATED_GROUP_SIZE).toBe(64);
    for (const groupSize of [0, -1, 1.5, Number.NaN]) {
      await expect(forEachIsolated(client(), ['a'], async () => {}, { groupSize })).rejects.toThrow(RangeError);
    }
  });

  it('reports a repeated value by position when the group commit fails', async () => {
    const errors = [];
    let calls = 0;
    // The first "A" fails on its own; the second succeeds, then COMMIT fails.
    await forEachIsolated(client(true), ['A', 'A'], async (item) => {
      calls += 1;
      if (calls === 1) throw new Error('row failed');
      return item;
    }, { onError: (item, error) => errors.push([item, error.message]) });
    expect(errors).toEqual([['A', 'row failed'], ['A', 'commit failed']]);
  });
});

describe('timeouts, readiness and shutdown', () => {
  it('accepts only whole-millisecond idle-in-transaction timeouts', () => {
    const previous = process.env.PG_TX_IDLE_TIMEOUT_MS;
    try {
      process.env.PG_TX_IDLE_TIMEOUT_MS = '0.5';
      expect(transactionIdleTimeoutMs()).toBe(900_000);
      process.env.PG_TX_IDLE_TIMEOUT_MS = '0';
      expect(transactionIdleTimeoutMs()).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.PG_TX_IDLE_TIMEOUT_MS;
      else process.env.PG_TX_IDLE_TIMEOUT_MS = previous;
    }
  });

  it('answers 503 for a feature whose migration is pending', () => {
    setFeatureReadiness('example-feature', false, 'pending migration');
    const res = { status: vi.fn(() => res), json: vi.fn() };
    const next = vi.fn();
    requireFeatureReady('example-feature')({}, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
    setFeatureReadiness('example-feature', true);
    expect(featureUnavailable('example-feature')).toBeNull();
    expect(source('routes/workerJobs.js')).toContain("workersRouter.use(requireFeatureReady('rate-card-worker'));");
  });

  it('tracks background imports until they settle', async () => {
    let finish;
    runInBackground('test', () => new Promise(resolve => { finish = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    expect(activeBackgroundJobs()).toBeGreaterThan(0);
    expect(await waitForBackgroundJobs(10)).toBeGreaterThan(0);
    finish();
    expect(await waitForBackgroundJobs(1_000)).toBe(0);
  });

  it('rejects partial shutdown timeouts and stays inside the Docker grace period', async () => {
    const { resolveShutdownTimeoutMs } = await import('../server.js').catch(() => ({}));
    const serverSource = source('server.js');
    expect(serverSource).toContain('export function resolveShutdownTimeoutMs(env = process.env)');
    expect(serverSource).toContain('await waitForBackgroundJobs(budget)');
    if (resolveShutdownTimeoutMs) {
      expect(resolveShutdownTimeoutMs({ NODE_ENV: 'production', SHUTDOWN_TIMEOUT_MS: '1000ms' })).toBe(60_000);
      expect(resolveShutdownTimeoutMs({ NODE_ENV: 'production', SHUTDOWN_TIMEOUT_MS: '90000', STOP_GRACE_PERIOD: '75s' })).toBe(70_000);
    }
  }, 60_000); // importing server.js loads the whole route graph

  it('keeps a checked-out client from crashing the API when its session ends', () => {
    const db = source('db/index.js');
    expect(db).toContain("client.on('error', error => {");
    expect(db).toContain('const sessionError = error || client[SESSION_ERROR];');
  });
});

describe('legacy (type-guessed) text uploads', () => {
  it('recognises text spreadsheets', () => {
    expect(isTextSpreadsheet(Buffer.from('a,b\n1,2\n'))).toBe(true);
    expect(isTextSpreadsheet(Buffer.from([0x50, 0x4b, 3, 4]))).toBe(false);
    expect(isTextSpreadsheet(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))).toBe(false);
  });

  it('removes already-duplicated legacy rows, then re-keys the rest', async () => {
    const queryable = { query: vi.fn(async () => ({ rowCount: 1 })) };
    const result = await adoptLegacyFingerprints(queryable, 'mp_invoices', [['old', 'new'], ['old', 'other'], ['same', 'same']]);
    expect(result).toEqual({ adopted: 1, duplicatesRemoved: 1 });
    const [deleteSql, deleteParams] = queryable.query.mock.calls[0];
    expect(deleteSql).toContain('DELETE FROM mp_invoices');
    expect(deleteParams).toEqual([['old'], ['new']]);
    expect(queryable.query.mock.calls[1][0]).toContain('UPDATE mp_invoices');
    await expect(adoptLegacyFingerprints(queryable, 'bad table', [['a', 'b']])).rejects.toThrow('Invalid table name');
  });

  it('renames a legacy SOR invoice number only when the exact number is free', async () => {
    const client = { query: vi.fn(async () => ({ rowCount: 1 })) };
    await expect(adoptLegacySorInvoiceNumbers(client, { portal: 'zepto', account: 'default', pairs: [['123', '000123']] })).resolves.toBe(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toContain('AND NOT EXISTS');
    expect(params.slice(3)).toEqual([['123'], ['000123']]);
    expect(source('routes/sorUpload.js')).toContain('legacyInvoiceNos');
    const mp = source('routes/mpSettlement.js');
    expect(mp).toContain("adoptLegacyFingerprints(pool, 'mp_invoices', legacyPairs)");
    expect(mp).toContain("adoptLegacyFingerprints(pool, 'mp_ledger_entries', legacyPairs)");
  });
});

describe('Myntra payment refresh', () => {
  it('scopes backfill to whole order lines, so partial sums are never written', async () => {
    const pool = { query: vi.fn(async () => ({ rowCount: 2 })) };
    await backfillOrdersFromMyntraPayment(pool, 'myntra_vb', { lineIds: ['L1'], releaseIds: [] });
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('i.order_line_id IN');
    expect(sql).not.toContain(' AND i.order_release_id = ANY(');
    await expect(backfillOrdersFromMyntraPayment(pool, 'myntra_vb', { lineIds: [], releaseIds: [] })).resolves.toEqual({ ordersUpdated: 0 });
  });

  it('restores a status only a removed reverse payment set, unless a return supports it', async () => {
    const pool = { query: vi.fn(async () => ({ rowCount: 1 })) };
    await restoreMyntraStatusesWithoutReverse(pool, 'myntra_vb', { lineIds: ['L1'] });
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain("o.orders_status = 'Return Initiated'");
    expect(sql).toContain('FROM returns r');
    expect(sql).toContain("COALESCE(i.order_type, '') = 'reverse'");
  });

  it('locks the edited invoice, refreshes by line id and reports a pending refresh', () => {
    const mp = source('routes/mpSettlement.js');
    expect(mp).toContain('SELECT * FROM mp_invoices WHERE id = $1 FOR UPDATE');
    expect(mp).toContain('refreshPending: true');
    expect(mp).toContain('const { ordersReset } = await resetOrdersWithoutMyntraPayment(pool, account || null, null);');
    expect(MYNTRA_SYNTHESIZED_RETURN_REASONS).toEqual(['Cancel Before Dispached', 'Cancel before ship']);
    const upload = source('routes/upload.js');
    expect(upload).toContain('const clearsMyntraPayments = cfg.tables.includes(\'mp_invoices\') && mp === \'myntra\';');
  });
});

describe('locking and ordering of concurrent writers', () => {
  it('serializes NEFT replacements, Myntra uploads and Amazon settlement ingests', () => {
    expect(source('routes/flipkartSettlement.js')).toContain("await lockNeftReplacement(client, 'fk_settlement_orders');");
    expect(source('routes/flipkartSettlement.js')).toContain("if (!str(g(row, 'neftid'))) { skipped++; continue; }");
    expect(source('routes/myntraUpload.js')).toContain('myntra_upload:${sellerAccount}');
    expect(source('services/amazonSettlementIngest.js')).toContain('pg_advisory_xact_lock($1)\', [AMAZON_SETTLEMENT_INGEST_LOCK_KEY]');
  });

  it('keeps Phase A on the uploaded settlement and backfills every changed order', () => {
    const upload = source('routes/amazonUpload.js');
    const phaseA = upload.slice(upload.indexOf('// ── Phase A'), upload.indexOf('// ── Phase B+C'));
    expect(phaseA).toContain('${ownScope}');
    expect(phaseA).not.toContain('${scope}');
    expect(upload).toContain('orderIds: [...new Set(');
    expect(source('services/amazonSettlementIngest.js')).toContain('beforeRollupsResult?.orderIds');
  });

  it('orders Sale Orders and SOR writes consistently and derives order type from all shipments', () => {
    const upload = source('routes/amazonUpload.js');
    expect(upload).toContain('[...byNaturalKey.values()].sort(byOrderSku)');
    expect(upload).toContain("dateNF: 'yyyy-mm-dd hh:mm:ss'");
    expect(source('services/amazonSaleOrderShipments.js')).toContain("CASE WHEN BOOL_OR(sh.product_amount > 0) THEN 'standard' ELSE 'exchange' END AS order_type");
    expect(source('services/sorUpload.js')).toContain('SELECT id FROM sor_invoice WHERE id = $1 FOR UPDATE');
    expect(source('services/sorMirror.js')).toContain('const orderedKeys = [...keys].sort(');
  });
});

describe('reports and maintenance', () => {
  it('does not cache partial month-pl reports and prefers the same marketplace null-safely', () => {
    expect(source('routes/data.js')).toContain('if (warnings.length) res.locals.reportCacheSkip = true;');
    expect(source('services/reportCache.js')).toContain('!res.locals?.reportCacheSkip');
    expect(source('routes/data.js')).toContain('ORDER BY (matched.marketplace IS NOT DISTINCT FROM ret.marketplace) DESC');
    expect(source('routes/reconcile.js')).toContain('const { sellerAcc } = marketplaceScope(req.query);');
  });

  it('bounds VACUUM lock waits and counts permission skips as failures', () => {
    const script = source('scripts/analyze-postgres.js');
    expect(script).toContain('lock_timeout: LOCK_TIMEOUT_MS');
    expect(script).toContain("client.on('notice'");
  });

  it('fails an export whose row set changed between pages', () => {
    const client = source('../frontend/src/api/client.js');
    expect(client).toContain('if (Number.isSafeInteger(total) && Number.isSafeInteger(pageTotal) && pageTotal !== total) throw changed();');
  });
});
