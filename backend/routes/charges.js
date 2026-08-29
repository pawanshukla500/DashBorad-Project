import express from 'express';
import { getPool, isDbConfigured } from '../db/index.js';
import { requireAdmin } from '../utils/authMiddleware.js';
import { optionalNumber } from '../utils/valueParsers.js';

const router = express.Router();
router.use(requireAdmin);

const CUSTOM_CHARGE_TYPES = new Set(['per_order', 'pct_revenue', 'fixed_monthly']);

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function normalizedKey(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return /^[a-z][a-z0-9_]{1,63}$/.test(key) ? key : null;
}

function normalizedLabel(value) {
  const label = String(value ?? '').trim();
  return label && label.length <= 120 ? label : null;
}

function normalizedCustomType(value) {
  if (value == null || value === '') return null;
  return CUSTOM_CHARGE_TYPES.has(value) ? value : null;
}

function normalizedCustomValue(value, type) {
  if (value == null || value === '') return null;
  const amount = optionalNumber(value);
  if (amount == null || amount < 0) return null;
  if (type === 'pct_revenue' && amount > 100) return null;
  return amount;
}

// GET /api/charges
router.get('/', async (req, res) => {
  if (!(await isDbConfigured())) return res.json([]);
  try {
    const { rows } = await getPool().query(
      `SELECT id, key, label, category, source, enabled, custom_type, custom_value, sort_order
       FROM charges_config ORDER BY sort_order, id`
    );
    res.json(rows.map(r => ({
      id: r.id,
      key: r.key,
      label: r.label,
      category: r.category,
      source: r.source,
      enabled: r.enabled,
      customType: r.custom_type,
      customValue: r.custom_value != null ? +r.custom_value : null,
      sortOrder: r.sort_order,
    })));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// PUT /api/charges/:key  — toggle or update a charge
router.put('/:key', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const { enabled, label, customType, customValue } = req.body;
    const key = normalizedKey(req.params.key);
    if (!key) throw inputError('Invalid charge key');
    const existing = await pool.query(
      `SELECT key, custom_type FROM charges_config WHERE key = $1`,
      [key],
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Charge not found' });
    const sets = [];
    const vals = [];
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') throw inputError('enabled must be true or false');
      sets.push(`enabled = $${vals.push(enabled)}`);
    }
    if (label !== undefined) {
      const value = normalizedLabel(label);
      if (!value) throw inputError('label must contain 1 to 120 characters');
      sets.push(`label = $${vals.push(value)}`);
    }
    const effectiveType = customType !== undefined
      ? normalizedCustomType(customType)
      : existing.rows[0].custom_type;
    if (customType !== undefined) {
      if (customType != null && customType !== '' && !effectiveType) throw inputError('Invalid custom charge type');
      sets.push(`custom_type = $${vals.push(effectiveType)}`);
    }
    if (customValue !== undefined) {
      const value = normalizedCustomValue(customValue, effectiveType);
      if (customValue != null && customValue !== '' && value == null) {
        throw inputError(effectiveType === 'pct_revenue'
          ? 'custom value must be a percentage from 0 to 100'
          : 'custom value must be a non-negative number');
      }
      sets.push(`custom_value = $${vals.push(value)}`);
    }
    if (!sets.length) return res.json({ ok: true });
    sets.push(`updated_at = NOW()`);
    vals.push(key);
    const result = await pool.query(
      `UPDATE charges_config SET ${sets.join(', ')} WHERE key = $${vals.length} RETURNING key, label, enabled, custom_type, custom_value`,
      vals,
    );
    res.json({ ok: true, charge: result.rows[0] });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/charges  — add custom charge
router.post('/', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const { key, label, customType, customValue } = req.body;
    const safeKey = normalizedKey(key);
    const safeLabel = normalizedLabel(label);
    const safeType = normalizedCustomType(customType);
    const safeValue = normalizedCustomValue(customValue, safeType);
    if (!safeKey || !safeLabel) throw inputError('key and label are required; key must use lowercase letters, numbers, and underscores');
    if (customType != null && customType !== '' && !safeType) throw inputError('Invalid custom charge type');
    if (customValue != null && customValue !== '' && safeValue == null) {
      throw inputError(safeType === 'pct_revenue'
        ? 'custom value must be a percentage from 0 to 100'
        : 'custom value must be a non-negative number');
    }
    const { rows } = await pool.query(
      `INSERT INTO charges_config (key, label, category, source, enabled, custom_type, custom_value)
       VALUES ($1, $2, 'custom', 'custom', true, $3, $4)
       ON CONFLICT (key) DO UPDATE SET label=$2, custom_type=$3, custom_value=$4, updated_at=NOW()
       RETURNING *`,
      [safeKey, safeLabel, safeType, safeValue]
    );
    res.json({ ok: true, charge: rows[0] });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// DELETE /api/charges/:key  — only custom charges can be deleted
router.delete('/:key', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const key = normalizedKey(req.params.key);
    if (!key) throw inputError('Invalid charge key');
    const { rowCount } = await getPool().query(
      `DELETE FROM charges_config WHERE key = $1 AND source = 'custom'`,
      [key]
    );
    if (!rowCount) return res.status(404).json({ error: 'Not found or not a custom charge' });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

export default router;
