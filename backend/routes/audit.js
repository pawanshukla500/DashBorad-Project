import express from 'express';
import { getPool, isDbConfigured } from '../db/index.js';
import { requireAdmin } from '../utils/authMiddleware.js';
import { optionalQueryText, pagination } from '../utils/requestParams.js';

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res) => {
  try {
    if (!(await isDbConfigured())) return res.json({ data: [], total: 0, page: 1, pageSize: 50 });
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 50, maxPageSize: 100 });
    const values = [];
    const where = [];

    const action = optionalQueryText(req.query.action, 'Action filter', { maxLength: 100 });
    const actor = optionalQueryText(req.query.actor, 'Actor filter', { maxLength: 160 });
    if (action) {
      values.push(`%${action}%`);
      where.push(`action ILIKE $${values.length}`);
    }
    if (actor) {
      values.push(`%${actor}%`);
      where.push(`(actor_email ILIKE $${values.length} OR actor_role ILIKE $${values.length})`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const listValues = [...values, pageSize, offset];
    const [rows, count] = await Promise.all([
      getPool().query(
        `SELECT id, actor_email, actor_role, action, entity_type, entity_id, details, ip_address, created_at
         FROM audit_events ${clause}
         ORDER BY created_at DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        listValues
      ),
      getPool().query(`SELECT COUNT(*) AS total FROM audit_events ${clause}`, values),
    ]);

    res.json({ data: rows.rows, total: +(count.rows[0]?.total || 0), page, pageSize });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

export default router;
