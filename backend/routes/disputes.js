import express from 'express';
import { getPool, isDbConfigured } from '../db/index.js';
import { optionalNumber } from '../utils/valueParsers.js';

const router = express.Router();
const DISPUTE_STATUSES = new Set([
  'open', 'raised', 'submitted', 'in_review', 'accepted', 'rejected', 'resolved', 'closed',
]);

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function cleanIdentifier(value, label, maxLength = 100) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength) throw inputError(`${label} must contain 1 to ${maxLength} characters`);
  return text;
}

function canonicalDisputeStatus(value) {
  const status = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return DISPUTE_STATUSES.has(status) ? status : null;
}

function optionalAmount(value, label) {
  if (value == null || value === '') return null;
  const parsed = optionalNumber(value);
  if (parsed == null) throw inputError(`invalid ${label}`);
  return parsed;
}

export function parseDisputeInput(input = {}) {
  const orderItemId = cleanIdentifier(input.order_item_id, 'order_item_id', 250);
  const feeType = cleanIdentifier(input.fee_type, 'fee_type', 100);
  const disputeStatus = canonicalDisputeStatus(input.dispute_status);
  if (!disputeStatus) throw inputError('invalid dispute_status');
  return {
    values: [
      orderItemId,
      feeType,
      optionalAmount(input.expected_amount, 'expected_amount'),
      optionalAmount(input.actual_amount, 'actual_amount'),
      disputeStatus,
    ],
  };
}

router.get('/', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const pool = getPool();
    const { rows } = await pool.query('SELECT * FROM fee_disputes');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const { values } = parseDisputeInput(req.body);
    const [orderItemId, feeType, expectedAmount, actualAmount, disputeStatus] = values;
    const pool = getPool();
    const { rows } = await pool.query(`
      INSERT INTO fee_disputes (order_item_id, fee_type, expected_amount, actual_amount, dispute_status)
      SELECT $1, $2, $3, $4, $5
      WHERE EXISTS (SELECT 1 FROM orders WHERE order_item_id = $1)
      ON CONFLICT (order_item_id, fee_type) DO UPDATE
      SET dispute_status = EXCLUDED.dispute_status,
          expected_amount = COALESCE(EXCLUDED.expected_amount, fee_disputes.expected_amount),
          actual_amount = COALESCE(EXCLUDED.actual_amount, fee_disputes.actual_amount),
          updated_at = NOW()
      RETURNING *
    `, [orderItemId, feeType, expectedAmount, actualAmount, disputeStatus]);
    if (!rows[0]) return res.status(404).json({ error: 'Order item not found' });
    res.json({ ok: true, dispute: rows[0] });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

export default router;
