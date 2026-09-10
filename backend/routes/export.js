import express from 'express';
import { getPool, isDbConfigured } from '../db/index.js';
import { requireRole } from '../utils/authMiddleware.js';
import {
  BENCHMARK_MARKETPLACES,
  getSkuSettlementBenchmark,
  getSkuSettlementMonths,
} from '../services/skuSettlementBenchmark.js';
import { sendSkuSettlementBenchmarkNotification } from '../services/skuSettlementNotifications.js';

const router = express.Router();

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function parseMonthlyDetailedQuery(query = {}) {
  const month = typeof query.month === 'string' ? query.month.trim() : '';
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) {
    throw inputError('Month must be YYYY-MM');
  }
  const rawMarketplace = query.marketplace == null ? '' : String(query.marketplace).trim().toLowerCase();
  if (rawMarketplace && rawMarketplace !== 'all' && !/^[a-z0-9][a-z0-9_-]{0,49}$/.test(rawMarketplace)) {
    throw inputError('Marketplace filter is invalid');
  }
  const [year, numericMonth] = month.split('-').map(Number);
  const startDate = new Date(Date.UTC(year, numericMonth - 1, 1));
  const endDate = new Date(Date.UTC(year, numericMonth, 1));
  return {
    month,
    marketplace: rawMarketplace && rawMarketplace !== 'all' ? rawMarketplace : null,
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
  };
}

export function buildMonthlyDetailedSql({ marketplace, startDate, endDate }) {
  const values = [];
  const filters = [];
  if (marketplace) filters.push(`o.marketplace = $${values.push(marketplace)}`);
  filters.push(`o.order_date >= $${values.push(startDate)}::date`);
  filters.push(`o.order_date < $${values.push(endDate)}::date`);
  return {
    values,
    text: `
      WITH scoped_orders AS (
        SELECT o.*
        FROM orders o
        WHERE ${filters.join(' AND ')}
      ),
      sett AS (
        SELECT s.order_item_id,
          SUM(s.bank_settlement) as bank_settlement,
          SUM(s.commission) as commission,
          SUM(s.fixed_fee) as fixed_fee,
          SUM(s.collection_fee) as collection_fee,
          SUM(s.pick_pack_fee) as pick_pack_fee,
          SUM(s.shipping_fee) as shipping_fee,
          SUM(s.reverse_shipping) as reverse_shipping
        FROM unified_settlements s
        JOIN scoped_orders o ON o.order_item_id = s.order_item_id
        GROUP BY s.order_item_id
      )
      SELECT
        o.order_item_id,
        TO_CHAR(o.order_date, 'YYYY-MM-DD') as order_date,
        o.category,
        o.brand_name,
        o.final_invoice_amount,
        o.fulfilment_type,
        s.bank_settlement,
        s.commission,
        s.fixed_fee,
        s.collection_fee,
        s.pick_pack_fee,
        s.shipping_fee,
        s.reverse_shipping,
        fd_comm.dispute_status as comm_dispute,
        fd_fixed.dispute_status as fixed_dispute
      FROM scoped_orders o
      LEFT JOIN sett s ON s.order_item_id = o.order_item_id
      LEFT JOIN fee_disputes fd_comm ON fd_comm.order_item_id = o.order_item_id AND fd_comm.fee_type = 'commission'
      LEFT JOIN fee_disputes fd_fixed ON fd_fixed.order_item_id = o.order_item_id AND fd_fixed.fee_type = 'fixed_fee'
      ORDER BY o.order_date DESC, o.order_item_id
    `,
  };
}

// Compact, marketplace-wise SKU settlement benchmark.  The query only reads
// the selected settlement month and its immediate predecessor, so it avoids a
// full historical scan on PostgreSQL every time the payment page is opened.
router.get('/sku-settlement/months', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  const marketplace = String(req.query.marketplace || 'flipkart').toLowerCase();
  if (!BENCHMARK_MARKETPLACES.includes(marketplace)) return res.status(400).json({ error: 'Unsupported marketplace' });
  try {
    res.json({ marketplace, months: await getSkuSettlementMonths(getPool(), marketplace) });
  } catch (error) {
    console.error('[sku settlement months]', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/sku-settlement/benchmark', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  const marketplace = String(req.query.marketplace || 'flipkart').toLowerCase();
  const month = req.query.month ? String(req.query.month) : null;
  if (!BENCHMARK_MARKETPLACES.includes(marketplace)) return res.status(400).json({ error: 'Unsupported marketplace' });
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'Month must be YYYY-MM' });
  try {
    res.json(await getSkuSettlementBenchmark(getPool(), { marketplace, month }));
  } catch (error) {
    console.error('[sku settlement benchmark]', error);
    res.status(500).json({ error: error.message });
  }
});

// This does not email on every screen refresh.  An operator can send the
// reviewed, thresholded alert list to the finance mailbox; duplicate sends for
// the same marketplace/month are recorded and blocked by the service.
router.post('/sku-settlement/notify', requireRole('operator', 'admin'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  const marketplace = String(req.body?.marketplace || 'flipkart').toLowerCase();
  const month = req.body?.month ? String(req.body.month) : null;
  if (!BENCHMARK_MARKETPLACES.includes(marketplace)) return res.status(400).json({ error: 'Unsupported marketplace' });
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'Month must be YYYY-MM' });
  try {
    const pool = getPool();
    const report = await getSkuSettlementBenchmark(pool, { marketplace, month });
    const notification = await sendSkuSettlementBenchmarkNotification(pool, report, req.user);
    res.json({ ...notification, reportMonth: report.month, alerts: report.summary.alerts });
  } catch (error) {
    console.error('[sku settlement notification]', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/export/monthly-detailed?month=2026-05&marketplace=flipkart
router.get('/monthly-detailed', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });

  try {
    const query = parseMonthlyDetailedQuery(req.query);
    const pool = getPool();
    const { text, values } = buildMonthlyDetailedSql(query);
    const { rows } = await pool.query(text, values);
    res.json({ data: rows });
  } catch (err) {
    console.error('[export]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
