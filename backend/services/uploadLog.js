import { forEachDbBatch } from '../utils/dbBatch.js';
import { pagination } from '../utils/requestParams.js';

export async function logUpload(
  pool,
  type,
  filename,
  marketplace,
  inserted,
  updated,
  skipped,
  status,
  errorMsg = null,
) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO upload_log (
         data_type, filename, marketplace, rows_inserted, rows_updated,
         rows_skipped, status, error_msg
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [type, filename, marketplace || 'flipkart', inserted, updated, skipped, status, errorMsg],
    );
    return rows[0]?.id ?? null;
  } catch (error) {
    console.warn('[uploadLog.logUpload]', error.message);
    return null;
  }
}

export async function saveSkippedRows(pool, logId, skippedRows) {
  if (!logId || !skippedRows.length) return;
  await forEachDbBatch(skippedRows, 4, async batch => {
    const values = [];
    const groups = batch.map(({ rowNum, reason, data }) => {
      const start = values.length;
      values.push(logId, rowNum, reason, JSON.stringify(data));
      return `($${start + 1},$${start + 2},$${start + 3},$${start + 4})`;
    });
    await pool.query(
      `INSERT INTO upload_skipped_rows (upload_log_id, row_num, skip_reason, raw_json)
       VALUES ${groups.join(',')}`,
      values,
    );
  });
}

export async function getUploadHistory(pool, query = {}) {
  const { page, pageSize, offset } = pagination(query, {
    defaultPageSize: 25,
    maxPageSize: 100,
  });
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  if (query.marketplace) add("LOWER(COALESCE(marketplace, 'flipkart')) = LOWER(?)", query.marketplace);
  if (query.dataType) add('data_type = ?', query.dataType);
  if (query.status === 'cleared') {
    where.push('data_cleared_at IS NOT NULL');
  } else if (query.status) {
    add('status = ?', query.status);
  }
  if (query.search?.trim()) {
    params.push(`%${query.search.trim()}%`);
    const searchParam = `$${params.length}`;
    where.push(`(
      filename ILIKE ${searchParam} OR data_type ILIKE ${searchParam} OR
      COALESCE(remark, '') ILIKE ${searchParam} OR
      COALESCE(error_msg, '') ILIKE ${searchParam} OR
      COALESCE(clear_reason, '') ILIKE ${searchParam} OR
      COALESCE(cleared_by_email, '') ILIKE ${searchParam}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(pageSize, offset);
  const result = await pool.query(`
    SELECT
      id, data_type, filename, marketplace,
      COALESCE(rows_inserted, 0) AS rows_inserted,
      COALESCE(rows_updated, 0) AS rows_updated,
      COALESCE(rows_skipped, 0) AS rows_skipped,
      status, error_msg, remark, uploaded_at,
      data_cleared_at, cleared_by, cleared_by_email, clear_reason,
      cleared_row_counts,
      COUNT(*) OVER () AS total_count
    FROM upload_log
    ${whereSql}
    ORDER BY uploaded_at DESC, id DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);

  const total = Number(result.rows[0]?.total_count || 0);
  const rows = result.rows.map(({ total_count: _totalCount, ...row }) => row);
  return { rows, pagination: { page, pageSize, total } };
}
