import express from 'express';
import multer from 'multer';
import { createRequire } from 'module';
import { getPool, isDbConfigured } from '../db/index.js';
import { optionalString as str } from '../utils/valueParsers.js';
import { normalizeSqlDate } from '../utils/dateNormalizer.js';
import { refreshOrderSettlementTotals } from '../services/orderSettlementTotals.js';
import { logUpload, saveSkippedRows } from '../services/uploadLog.js';
import { forEachDbBatch } from '../utils/dbBatch.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });
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
    const skuBackfills = [];

    rawRows.forEach((row, index) => {
      const subOrderNo = str(row['Sub Order No']);
      const supplierSku = str(row['Supplier SKU']);
      const paymentDate = normalizeSqlDate(row['Payment Date'] || row['Order Date']); 
      
      if (!subOrderNo) {
        skippedRows.push({ rowNum: index + 2, reason: 'Sub Order No is empty', data: row });
        return;
      }

      const bankSettlement = Number(row['Final Settlement Amount'] || 0);
      const saleAmount = Number(row['Total Sale Amount (Incl. Shipping & GST)'] || 0);
      const comm = Number(row['Meesho Commission (Incl. GST)'] || 0);
      const fixed = Number(row['Fixed Fee (Incl. GST)_1'] || row['Fixed Fee (Incl. GST)'] || 0);
      const ship = Number(row['Shipping Charge (Incl. GST)'] || 0);
      const revShip = Number(row['Return Shipping Charge (Incl. GST)'] || 0);
      const tcs = Number(row['TCS'] || 0);
      const tds = Number(row['TDS'] || 0);
      const claims = Number(row['Compensation'] || row['Recovery'] || row['Claims'] || 0);
      const transactionType = str(row['Live Order Status']) || 'Settlement';
      const settlementId = str(row['Transaction ID']) || 'MS-' + (paymentDate || Date.now());

      validItems.push([
        settlementId, paymentDate, subOrderNo, supplierSku, transactionType,
        bankSettlement, saleAmount, comm, fixed, ship, revShip, tcs, tds, claims,
      ]);

      if (supplierSku) {
        skuBackfills.push({ sku: supplierSku, subOrderNo });
      }
    });

    const COLUMNS = [
      'settlement_id', 'payment_date', 'order_item_id', 'sku', 'transaction_type',
      'bank_settlement', 'sale_amount', 'commission_fee', 'fixed_fee', 'shipping_fee',
      'reverse_shipping', 'tcs', 'tds', 'claims',
    ];
    const columnSql = COLUMNS.join(', ');

    await forEachDbBatch(validItems, COLUMNS.length, async batch => {
      const values = [];
      const groups = batch.map(row => {
        const start = values.length;
        values.push(...row);
        return `(${row.map((_, idx) => `$${start + idx + 1}`).join(', ')})`;
      });

      const result = await pool.query(
        `INSERT INTO meesho_settlement_items (${columnSql}) VALUES ${groups.join(', ')}`,
        values,
      );
      inserted += result.rowCount;
    });

    // Optional SKU backfill for orders
    if (skuBackfills.length > 0) {
      for (const item of skuBackfills) {
        await pool.query(
          `UPDATE orders SET sku = $1 WHERE order_item_id = $2 AND (sku IS NULL OR sku = '') AND marketplace = 'meesho'`,
          [item.sku, item.subOrderNo],
        ).catch(() => {});
      }
    }

    await refreshOrderSettlementTotals(pool).catch(e => console.warn('[meeshoUpload] refreshOrderSettlementTotals warning:', e.message));

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
