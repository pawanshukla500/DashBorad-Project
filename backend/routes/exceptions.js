import express from 'express';
import { getPool, isDbConfigured } from '../db/index.js';
import { requireRole } from '../utils/authMiddleware.js';

const router = express.Router();

function exception({
  key,
  type,
  severity = 'warning',
  title,
  detail,
  count = 1,
  marketplace = null,
  route = '/',
  createdAt = null,
}) {
  return { key, type, severity, title, detail, count: +count || 0, marketplace, route, createdAt };
}

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function parseExceptionResolutionInput(keyValue, input = {}) {
  const key = String(keyValue ?? '').trim();
  if (!key || key.length > 500) throw inputError('exception key must contain 1 to 500 characters');
  const status = String(input.status ?? '').trim().toLowerCase();
  if (!['open', 'resolved'].includes(status)) throw inputError('status must be open or resolved');
  const note = input.note == null ? null : String(input.note).trim();
  if (note && note.length > 1000) throw inputError('note must be 1000 characters or fewer');
  return { key, status, note: note || null };
}

router.get('/', async (req, res) => {
  try {
    if (!(await isDbConfigured())) return res.json({ summary: {}, items: [] });
    const pool = getPool();
    const [uploads, unmapped, unsettled, returns, rateGaps, resolutions] = await Promise.all([
      pool.query(`
        SELECT id, data_type, filename, marketplace, error_msg, uploaded_at
        FROM upload_log
        WHERE status = 'error'
        ORDER BY uploaded_at DESC LIMIT 20
      `),
      pool.query(`
        SELECT o.marketplace, o.sku, COUNT(*) AS count, MAX(o.order_date) AS last_seen
        FROM orders o
        LEFT JOIN sku_master sm
          ON LOWER(sm.listing_sku) = LOWER(o.sku)
         AND sm.marketplace IN (o.marketplace, 'all')
        WHERE o.sku IS NOT NULL AND o.sku <> '' AND sm.id IS NULL
        GROUP BY o.marketplace, o.sku
        ORDER BY count DESC LIMIT 25
      `),
      pool.query(`
        SELECT marketplace, COUNT(*) AS count, MIN(order_date) AS oldest
        FROM orders
        WHERE COALESCE(settlement_amount, 0) = 0
          AND order_date < CURRENT_DATE - INTERVAL '14 days'
          AND COALESCE(orders_status, '') ILIKE '%deliver%'
        GROUP BY marketplace
        ORDER BY count DESC
      `),
      pool.query(`
        SELECT marketplace, COUNT(*) AS count, MIN(return_requested_date) AS oldest
        FROM returns
        WHERE return_requested_date < CURRENT_DATE - INTERVAL '14 days'
          AND COALESCE(return_status, '') NOT ILIKE ALL (ARRAY['%complete%','%cancel%','%closed%'])
        GROUP BY marketplace
        ORDER BY count DESC
      `),
      pool.query(`
        SELECT o.marketplace, o.seller_account, o.category, COUNT(*) AS count
        FROM orders o
        LEFT JOIN rc_commission rc
          ON rc.marketplace = o.marketplace
         AND rc.seller_account = COALESCE(o.seller_account, 'default')
         AND LOWER(rc.category) = LOWER(o.category)
         AND (rc.start_date IS NULL OR rc.start_date <= CURRENT_DATE)
         AND (rc.end_date IS NULL OR rc.end_date >= CURRENT_DATE)
        WHERE o.category IS NOT NULL AND o.category <> ''
          AND o.order_date >= CURRENT_DATE - INTERVAL '90 days'
          AND rc.id IS NULL
        GROUP BY o.marketplace, o.seller_account, o.category
        ORDER BY count DESC LIMIT 25
      `),
      pool.query(`SELECT exception_key, status, note, resolved_at FROM exception_resolutions`),
    ]);

    const items = [
      ...uploads.rows.map(row => exception({
        key: `upload:${row.id}`,
        type: 'failed_upload',
        severity: 'critical',
        title: `Upload failed: ${row.filename || row.data_type}`,
        detail: row.error_msg || 'The file could not be processed.',
        marketplace: row.marketplace,
        route: '/upload',
        createdAt: row.uploaded_at,
      })),
      ...unmapped.rows.map(row => exception({
        key: `sku:${row.marketplace}:${row.sku}`,
        type: 'unmapped_sku',
        title: `Unmapped SKU: ${row.sku}`,
        detail: `${row.count} order${+row.count === 1 ? '' : 's'} cannot use master COGS data.`,
        count: row.count,
        marketplace: row.marketplace,
        route: '/profit-analysis',
        createdAt: row.last_seen,
      })),
      ...unsettled.rows.map(row => exception({
        key: `unsettled:${row.marketplace}`,
        type: 'unsettled_orders',
        severity: 'critical',
        title: `${row.count} delivered orders remain unsettled`,
        detail: `The oldest unsettled order is from ${row.oldest || 'an unknown date'}.`,
        count: row.count,
        marketplace: row.marketplace,
        route: '/settlement',
        createdAt: row.oldest,
      })),
      ...returns.rows.map(row => exception({
        key: `returns:${row.marketplace}`,
        type: 'unresolved_returns',
        title: `${row.count} returns need follow-up`,
        detail: `These returns have been open for more than 14 days.`,
        count: row.count,
        marketplace: row.marketplace,
        route: '/return-tracking',
        createdAt: row.oldest,
      })),
      ...rateGaps.rows.map(row => exception({
        key: `rate:${row.marketplace}:${row.seller_account}:${row.category}`,
        type: 'missing_rate_card',
        severity: 'critical',
        title: `Missing rate card: ${row.category}`,
        detail: `${row.count} recent orders have no active commission rate.`,
        count: row.count,
        marketplace: row.marketplace,
        route: '/rate-card-config',
      })),
    ];

    const resolutionMap = new Map(resolutions.rows.map(row => [row.exception_key, row]));
    const enriched = items.map(item => ({
      ...item,
      resolution: resolutionMap.get(item.key) || { status: 'open', note: null, resolved_at: null },
    }));
    const visible = req.query.includeResolved === 'true'
      ? enriched
      : enriched.filter(item => item.resolution.status !== 'resolved');

    const summary = visible.reduce((acc, item) => {
      acc.total = (acc.total || 0) + 1;
      acc[item.severity] = (acc[item.severity] || 0) + 1;
      acc[item.type] = (acc[item.type] || 0) + 1;
      return acc;
    }, {});

    res.json({ summary, items: visible });
  } catch (error) {
    console.error('[exceptions]', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:key/status', requireRole('operator', 'admin'), async (req, res) => {
  try {
    const { key, status, note } = parseExceptionResolutionInput(req.params.key, req.body);
    const result = await getPool().query(
      `INSERT INTO exception_resolutions
       (exception_key, status, note, resolved_by, resolved_at, updated_at)
       VALUES ($1,$2,$3,$4,CASE WHEN $2 = 'resolved' THEN NOW() ELSE NULL END,NOW())
       ON CONFLICT (exception_key) DO UPDATE SET
         status = EXCLUDED.status,
         note = EXCLUDED.note,
         resolved_by = EXCLUDED.resolved_by,
         resolved_at = EXCLUDED.resolved_at,
         updated_at = NOW()
       RETURNING *`,
      [key, status, note, req.user?.directory_user_id || null]
    );
    res.json({ resolution: result.rows[0] });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

export default router;
