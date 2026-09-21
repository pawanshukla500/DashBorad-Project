import express from 'express';
import multer from 'multer';
import { createRequire } from 'module';
import { getPool, isDbConfigured } from '../db/index.js';
import { optionalNumber as num, optionalString as str } from '../utils/valueParsers.js';
import { normalizeSqlDate } from '../utils/dateNormalizer.js';
import { refreshOrderSettlementTotals } from '../services/orderSettlementTotals.js';
import { logUpload, saveSkippedRows } from '../services/uploadLog.js';
import { forEachDbBatch } from '../utils/dbBatch.js';
import { spreadsheetFileFilter } from '../utils/uploadSecurity.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: spreadsheetFileFilter,
});
const router = express.Router();

router.post('/', upload.single('file'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  let pool;
  let inserted = 0;
  const skippedRows = [];

  try {
    pool = getPool();
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    
    // Auto-detect sheet containing settlement logic
    let orderSheet = wb.SheetNames.find(n => n.includes('Order Payments'));
    if (!orderSheet && wb.SheetNames.includes('Disclaimer')) {
      orderSheet = wb.SheetNames[1]; // Typically 2nd sheet
    }
    
    if (!orderSheet) {
      return res.status(400).json({ error: 'Could not find "Order Payments" sheet in Meesho payment file' });
    }

    // Use range: 1 to skip the first top-level grouping row. The headers will be read from row 2
    const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[orderSheet], { range: 1 });
    
    if (rawRows.length === 0) {
      return res.status(400).json({ error: 'Order Payments sheet is empty or only contains headers' });
    }

    const validItems = [];
    const skuBySubOrder = new Map();

    rawRows.forEach((row, index) => {
      const subOrderNo = str(row['Sub Order No']);
      const supplierSku = str(row['Supplier SKU']);
      const paymentDate = normalizeSqlDate(row['Payment Date'] || row['Order Date']);

      if (!subOrderNo) {
        skippedRows.push({ rowNum: index + 2, reason: 'Sub Order No is empty', data: row });
        return;
      }

      // Number("1,234") is NaN, which PostgreSQL NUMERIC stores and which then
      // turns every SUM over the column into NaN. Blank means 0; any other
      // unparseable value rejects the row with a reason.
      const invalid = [];
      const amount = (label, ...candidates) => {
        // Same column choice as the previous `a || b || 0`: first truthy cell.
        const raw = candidates.find(Boolean);
        if (raw === undefined || str(raw) == null) return 0;
        const parsed = num(raw);
        if (parsed == null) invalid.push(`${label} "${raw}"`);
        return parsed ?? 0;
      };
      const bankSettlement = amount('Final Settlement Amount', row['Final Settlement Amount']);
      const saleAmount = amount('Total Sale Amount', row['Total Sale Amount (Incl. Shipping & GST)']);
      const comm = amount('Meesho Commission', row['Meesho Commission (Incl. GST)']);
      const fixed = amount('Fixed Fee', row['Fixed Fee (Incl. GST)_1'], row['Fixed Fee (Incl. GST)']);
      const ship = amount('Shipping Charge', row['Shipping Charge (Incl. GST)']);
      const revShip = amount('Return Shipping Charge', row['Return Shipping Charge (Incl. GST)']);
      const tcs = amount('TCS', row['TCS']);
      const tds = amount('TDS', row['TDS']);
      const claims = amount('Claims', row['Compensation'], row['Recovery'], row['Claims']);
      if (invalid.length) {
        skippedRows.push({ rowNum: index + 2, reason: `Invalid amount: ${invalid.join(', ')}`, data: row });
        return;
      }
      const transactionType = str(row['Live Order Status']) || 'Settlement';
      // Deterministic fallback so a re-upload replaces the same rows.
      const settlementId = str(row['Transaction ID']) || `MS-${paymentDate || 'UNDATED'}`;

      validItems.push([
        settlementId, paymentDate, subOrderNo, supplierSku, transactionType,
        bankSettlement, saleAmount, comm, fixed, ship, revShip, tcs, tds, claims,
      ]);

      if (supplierSku) skuBySubOrder.set(subOrderNo, supplierSku);
    });

    const COLUMNS = [
      'settlement_id', 'payment_date', 'order_item_id', 'sku', 'transaction_type',
      'bank_settlement', 'sale_amount', 'commission_fee', 'fixed_fee', 'shipping_fee',
      'reverse_shipping', 'tcs', 'tds', 'claims',
    ];
    const columnSql = COLUMNS.join(', ');
    const settlementIds = [...new Set(validItems.map(row => row[0]))];

    // One transaction: replace this file's settlements (a plain INSERT
    // duplicated every amount when a file was uploaded twice), backfill SKUs,
    // and rebuild the per-order totals, or change nothing at all.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (settlementIds.length) {
        await client.query('DELETE FROM meesho_settlement_items WHERE settlement_id = ANY($1::text[])', [settlementIds]);
      }
      await forEachDbBatch(validItems, COLUMNS.length, async batch => {
        const values = [];
        const groups = batch.map(row => {
          const start = values.length;
          values.push(...row);
          return `(${row.map((_, idx) => `$${start + idx + 1}`).join(', ')})`;
        });

        const result = await client.query(
          `INSERT INTO meesho_settlement_items (${columnSql}) VALUES ${groups.join(', ')}`,
          values,
        );
        inserted += result.rowCount;
      });

      // Fill missing order SKUs in one statement (was one UPDATE per row).
      if (skuBySubOrder.size > 0) {
        await client.query(`
          UPDATE orders o
          SET sku = src.sku
          FROM unnest($1::text[], $2::text[]) AS src(order_item_id, sku)
          WHERE o.marketplace = 'meesho'
            AND o.order_item_id = src.order_item_id
            AND (o.sku IS NULL OR o.sku = '')
        `, [[...skuBySubOrder.keys()], [...skuBySubOrder.values()]]);
      }

      await refreshOrderSettlementTotals(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      inserted = 0;
      throw error;
    } finally {
      client.release();
    }

    const logId = await logUpload(pool, 'meesho_settlements', req.file.originalname, 'meesho', inserted, 0, skippedRows.length, 'ok');
    await saveSkippedRows(pool, logId, skippedRows).catch(() => {});

    res.json({
      ok: true,
      message: 'Success',
      marketplace: 'meesho',
      inserted,
      skipped: skippedRows.length,
      logId,
    });

  } catch (err) {
    if (pool) {
      const logId = await logUpload(pool, 'meesho_settlements', req.file?.originalname, 'meesho', inserted, 0, skippedRows.length, 'error', err.message).catch(() => null);
      if (logId) await saveSkippedRows(pool, logId, skippedRows).catch(() => {});
    }
    console.error('Meesho upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
