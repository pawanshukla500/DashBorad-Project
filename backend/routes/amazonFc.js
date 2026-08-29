import express from 'express';
import { getPool, isDbConfigured } from '../db/index.js';
import { requireAdmin } from '../utils/authMiddleware.js';

const router = express.Router();
const FC_TYPES = new Set(['FBA', 'Flex']);

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function normalizedFcCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{1,49}$/.test(code) ? code : null;
}

function normalizedLocation(value, label) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 100) throw inputError(`${label} must contain 1 to 100 characters`);
  return text;
}

router.get('/amazon-fc', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const { rows } = await pool.query('SELECT * FROM amazon_fc_master ORDER BY fc_code ASC');
    res.json(rows);
  } catch (error) {
    console.error('[GET /amazon-fc]', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/amazon-fc', requireAdmin, async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { fc_code, city, state, fc_type } = req.body;
    const code = normalizedFcCode(fc_code);
    if (!code) throw inputError('FC code must use uppercase letters, numbers, and hyphens only');
    const cleanCity = normalizedLocation(city, 'City');
    const cleanState = normalizedLocation(state, 'State').toUpperCase();
    const type = fc_type == null || fc_type === '' ? 'FBA' : String(fc_type).trim();
    if (!FC_TYPES.has(type)) throw inputError('FC type must be FBA or Flex');
    const pool = getPool();
    await pool.query(
      `INSERT INTO amazon_fc_master (fc_code, city, state, fc_type) 
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (fc_code) DO UPDATE SET city = EXCLUDED.city, state = EXCLUDED.state, fc_type = EXCLUDED.fc_type`,
      [code, cleanCity, cleanState, type]
    );
    res.json({ success: true, fc_code: code });
  } catch (error) {
    console.error('[POST /amazon-fc]', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.delete('/amazon-fc/:code', requireAdmin, async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const code = normalizedFcCode(req.params.code);
    if (!code) throw inputError('Invalid FC code');
    const { rowCount } = await getPool().query('DELETE FROM amazon_fc_master WHERE fc_code = $1', [code]);
    if (!rowCount) return res.status(404).json({ error: 'FC not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('[DELETE /amazon-fc]', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

export default router;
