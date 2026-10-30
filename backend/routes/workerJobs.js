import express from 'express';
import { getPool } from '../db/index.js';
import { requireRole } from '../utils/authMiddleware.js';
import { compareScrapedRatesWithActive } from '../services/rateCardCanonicalEngine.js';
import { publishRateCardObservations } from '../services/rateCardPublisher.js';

export const workersRouter = express.Router();
export const workerJobsRouter = express.Router();

/**
 * Register or update desktop worker instance
 * POST /api/workers/register
 */
workersRouter.post('/register', async (req, res) => {
  const { id, name, version, platform, capabilities = [], metadata = {} } = req.body;
  if (!id || !name) {
    return res.status(400).json({ error: 'Worker id and name are required' });
  }

  const pool = getPool();
  try {
    const result = await pool.query(`
      INSERT INTO workers (id, name, version, platform, status, last_heartbeat, capabilities, metadata, updated_at)
      VALUES ($1, $2, $3, $4, 'online', NOW(), $5, $6, NOW())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        version = EXCLUDED.version,
        platform = EXCLUDED.platform,
        status = 'online',
        last_heartbeat = NOW(),
        capabilities = EXCLUDED.capabilities,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
    `, [id, name, version || '2.0.0', platform || 'unknown', JSON.stringify(capabilities), JSON.stringify(metadata)]);

    res.json({ success: true, worker: result.rows[0] });
  } catch (err) {
    console.error('[Worker API] Register error:', err.message);
    res.status(500).json({ error: 'Failed to register worker', details: err.message });
  }
});

/**
 * Worker heartbeat ping & lease renewal
 * POST /api/workers/heartbeat
 */
workersRouter.post('/heartbeat', async (req, res) => {
  const { id, status = 'online' } = req.body;
  if (!id) return res.status(400).json({ error: 'Worker id is required' });

  const pool = getPool();
  try {
    await pool.query(`
      UPDATE workers 
      SET last_heartbeat = NOW(), status = $2, updated_at = NOW()
      WHERE id = $1
    `, [id, status]);

    // Renew lease on any active jobs held by this worker
    await pool.query(`
      UPDATE worker_jobs
      SET lease_expires_at = NOW() + INTERVAL '5 minutes', updated_at = NOW()
      WHERE lease_worker_id = $1 AND status IN ('claimed', 'running')
    `, [id]);

    res.json({ success: true, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[Worker API] Heartbeat error:', err.message);
    res.status(500).json({ error: 'Failed to update heartbeat' });
  }
});

/**
 * List workers with calculated online/offline status
 * GET /api/workers
 */
workersRouter.get('/', async (req, res) => {
  const pool = getPool();
  try {
    const result = await pool.query(`
      SELECT 
        id, name, version, platform,
        CASE 
          WHEN last_heartbeat >= NOW() - INTERVAL '60 seconds' THEN 'online'
          ELSE 'offline'
        END AS status,
        last_heartbeat, capabilities, metadata, created_at, updated_at
      FROM workers
      ORDER BY last_heartbeat DESC
      LIMIT 50
    `);
    res.json({ success: true, workers: result.rows });
  } catch (err) {
    console.error('[Worker API] List workers error:', err.message);
    res.status(500).json({ error: 'Failed to list workers' });
  }
});

/**
 * Desktop worker claims next available job atomically
 * POST /api/workers/jobs/claim
 */
workersRouter.post('/jobs/claim', async (req, res) => {
  const { worker_id } = req.body;
  if (!worker_id) return res.status(400).json({ error: 'Worker id is required' });

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fail expired jobs that exceeded max_attempts so they do not loop endlessly
    await client.query(`
      UPDATE worker_jobs
      SET status = 'failed', error_code = 'MAX_ATTEMPTS_EXCEEDED', error_message = 'Job failed: retry limit exceeded', updated_at = NOW()
      WHERE status IN ('claimed', 'running') AND lease_expires_at < NOW() AND attempts >= max_attempts
    `);

    const claimQuery = `
      SELECT id FROM worker_jobs
      WHERE (status = 'queued' OR (status IN ('claimed', 'running') AND lease_expires_at < NOW()))
        AND job_type = 'RATE_CARD_SCRAPE'
        AND attempts < max_attempts
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    const claimRes = await client.query(claimQuery);

    if (claimRes.rows.length === 0) {
      await client.query('COMMIT');
      return res.json({ success: true, job: null });
    }

    const jobId = claimRes.rows[0].id;
    const updateRes = await client.query(`
      UPDATE worker_jobs
      SET 
        status = 'claimed',
        lease_worker_id = $1,
        lease_expires_at = NOW() + INTERVAL '5 minutes',
        attempts = attempts + 1,
        updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [worker_id, jobId]);

    await client.query('COMMIT');
    res.json({ success: true, job: updateRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Worker API] Claim job error:', err.message);
    res.status(500).json({ error: 'Failed to claim job' });
  } finally {
    client.release();
  }
});

// ==========================================
// WORKER JOBS ROUTER (/api/worker-jobs)
// ==========================================

/**
 * Create a new worker job
 * POST /api/worker-jobs
 */
workerJobsRouter.post('/', requireRole('operator', 'admin'), async (req, res) => {
  const {
    marketplace = 'flipkart',
    seller_account = 'default',
    job_type = 'RATE_CARD_SCRAPE',
    parameters = {},
    priority = 0,
    idempotency_key = null
  } = req.body;

  const pool = getPool();
  try {
    const key = idempotency_key || `job-${marketplace}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const result = await pool.query(`
      INSERT INTO worker_jobs (
        idempotency_key, marketplace, seller_account, job_type,
        status, priority, parameters, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, NOW(), NOW())
      RETURNING *
    `, [key, marketplace, seller_account, job_type, priority, JSON.stringify(parameters), req.user?.email || 'system']);

    res.json({ success: true, job: result.rows[0] });
  } catch (err) {
    console.error('[Worker API] Create job error:', err.message);
    res.status(500).json({ error: 'Failed to create worker job', details: err.message });
  }
});

/**
 * List recent jobs with optional status/marketplace filter
 * GET /api/worker-jobs
 */
workerJobsRouter.get('/', async (req, res) => {
  const { status, marketplace, limit = 50 } = req.query;
  const pool = getPool();
  try {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) {
      conditions.push(`status = $${idx++}`);
      params.push(status);
    }
    if (marketplace) {
      conditions.push(`marketplace = $${idx++}`);
      params.push(marketplace);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 50, 100));
    params.push(safeLimit);

    const result = await pool.query(`
      SELECT 
        id, idempotency_key, marketplace, seller_account, job_type,
        status, priority, lease_worker_id, progress_pct, progress_message,
        attempts, diff_summary, error_message, created_by, created_at, updated_at, completed_at
      FROM worker_jobs
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${idx}
    `, params);

    res.json({ success: true, jobs: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list jobs' });
  }
});

/**
 * Get single job by ID
 * GET /api/worker-jobs/:id
 */
workerJobsRouter.get('/:id', async (req, res) => {
  const { id } = req.params;
  const pool = getPool();
  try {
    const result = await pool.query(`SELECT * FROM worker_jobs WHERE id = $1`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
    res.json({ success: true, job: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get job' });
  }
});

/**
 * Worker reports execution progress
 * POST /api/worker-jobs/:id/progress
 */
workerJobsRouter.post('/:id/progress', async (req, res) => {
  const { id } = req.params;
  const { progress_pct = 0, progress_message = '', worker_id = null } = req.body;

  const pool = getPool();
  try {
    const conditions = ['id = $1', "status IN ('claimed', 'running')"];
    const params = [id, progress_pct, progress_message];
    if (worker_id) {
      conditions.push('lease_worker_id = $4');
      params.push(worker_id);
    }

    const updateRes = await pool.query(`
      UPDATE worker_jobs
      SET status = 'running', progress_pct = $2, progress_message = $3, lease_expires_at = NOW() + INTERVAL '5 minutes', updated_at = NOW()
      WHERE ${conditions.join(' AND ')}
      RETURNING id, status
    `, params);

    if (updateRes.rows.length === 0) {
      return res.status(409).json({ error: 'Job is not running or no longer assigned to this worker', code: 'JOB_NOT_RUNNING' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Worker API] Progress error:', err.message);
    res.status(500).json({ error: 'Failed to record progress' });
  }
});

/**
 * Worker reports execution failure
 * POST /api/worker-jobs/:id/fail
 */
workerJobsRouter.post('/:id/fail', async (req, res) => {
  const { id } = req.params;
  const { error_message = 'Job execution failed', error_code = 'EXECUTION_ERROR', worker_id = null } = req.body;

  const pool = getPool();
  try {
    const jobRes = await pool.query('SELECT lease_worker_id, status FROM worker_jobs WHERE id = $1', [id]);
    if (jobRes.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    const currentJob = jobRes.rows[0];
    if (!['claimed', 'running'].includes(currentJob.status)) {
      return res.status(409).json({ error: 'Job is not running', code: 'JOB_NOT_ACTIVE' });
    }
    if (currentJob.lease_worker_id && (!worker_id || currentJob.lease_worker_id !== worker_id)) {
      return res.status(409).json({ error: 'Job lease belongs to another worker or lease has expired', code: 'LEASE_MISMATCH' });
    }

    const updateRes = await pool.query(`
      UPDATE worker_jobs
      SET status = 'failed', error_message = $2, error_code = $3, completed_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status IN ('claimed', 'running')
      RETURNING id, status
    `, [id, error_message, error_code]);

    if (updateRes.rows.length === 0) {
      return res.status(409).json({ error: 'Job is not running or no longer assigned to this worker', code: 'JOB_NOT_ACTIVE' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Worker API] Fail job error:', err.message);
    res.status(500).json({ error: 'Failed to record job failure' });
  }
});

/**
 * Worker delivers completed scrape results; backend runs canonical comparison
 * POST /api/worker-jobs/:id/results
 */
workerJobsRouter.post('/:id/results', async (req, res) => {
  const { id } = req.params;
  const { results = [], worker_id = null, effective_date = null } = req.body;

  if (!Array.isArray(results) || results.length === 0) {
    return res.status(400).json({ error: 'Results must be a non-empty array of rate card observations' });
  }

  const pool = getPool();
  try {
    const jobRes = await pool.query(
      `SELECT * FROM worker_jobs WHERE id = $1 AND status IN ('queued', 'claimed', 'running')`,
      [id]
    );
    if (jobRes.rows.length === 0) {
      return res.status(409).json({ error: 'Job is not active or has been cancelled', code: 'JOB_NOT_ACTIVE' });
    }

    const job = jobRes.rows[0];

    // If assigned to a worker lease, strictly enforce lease ownership and expiry
    if (job.lease_worker_id) {
      if (!worker_id || job.lease_worker_id !== worker_id) {
        return res.status(409).json({ error: 'Job lease belongs to another worker or lease has expired', code: 'LEASE_MISMATCH' });
      }
      if (job.lease_expires_at && new Date(job.lease_expires_at) < new Date()) {
        return res.status(409).json({ error: 'Job lease has expired', code: 'LEASE_EXPIRED' });
      }
    }

    // Determine effectiveDate from extraction or parameters
    const scrapeEffectiveDate = effective_date ||
      results.find(r => r.effectiveDate || r.source_effective_date)?.effectiveDate ||
      results.find(r => r.source_effective_date)?.source_effective_date ||
      job.parameters?.effectiveDate ||
      new Date().toISOString().slice(0, 10);

    // Run canonical diff engine against active PostgreSQL rate cards
    const diffResult = await compareScrapedRatesWithActive(results, {
      marketplace: job.marketplace,
      sellerAccount: job.seller_account,
      effectiveDate: scrapeEffectiveDate
    });

    const updateRes = await pool.query(`
      UPDATE worker_jobs
      SET 
        status = 'completed',
        progress_pct = 100,
        progress_message = 'Extraction completed. Diff analyzed.',
        results = $1,
        diff_summary = $2,
        completed_at = NOW(),
        updated_at = NOW()
      WHERE id = $3
        AND status IN ('queued', 'claimed', 'running')
        AND (lease_worker_id IS NULL OR lease_worker_id = $4)
      RETURNING *
    `, [JSON.stringify(results), JSON.stringify(diffResult), id, worker_id]);

    if (updateRes.rows.length === 0) {
      return res.status(409).json({ error: 'Job lease was reclaimed, cancelled, or expired before results could be saved', code: 'LEASE_LOST' });
    }

    res.json({
      success: true,
      job: updateRes.rows[0],
      diffResult
    });
  } catch (err) {
    console.error('[Worker API] Save results error:', err.message);
    res.status(500).json({ error: 'Failed to process job results', details: err.message });
  }
});

/**
 * Publish approved job results to active rc_* tables
 * POST /api/worker-jobs/:id/publish
 */
workerJobsRouter.post('/:id/publish', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const pool = getPool();

  try {
    const jobRes = await pool.query(`SELECT * FROM worker_jobs WHERE id = $1`, [id]);
    if (jobRes.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = jobRes.rows[0];
    if (!job.results || !Array.isArray(job.results)) {
      return res.status(400).json({ error: 'Job does not contain valid extraction results to publish' });
    }

    const effectiveDate = req.body?.effectiveDate ||
      job.diff_summary?.effectiveDate ||
      job.results.find(r => r.effectiveDate || r.source_effective_date)?.effectiveDate ||
      job.results.find(r => r.source_effective_date)?.source_effective_date ||
      job.parameters?.effectiveDate ||
      (job.completed_at ? new Date(job.completed_at).toISOString().slice(0, 10) : null) ||
      (job.created_at ? new Date(job.created_at).toISOString().slice(0, 10) : null) ||
      new Date().toISOString().slice(0, 10);

    const publishResult = await publishRateCardObservations(job.results, {
      marketplace: job.marketplace,
      sellerAccount: job.seller_account,
      effectiveDate,
      jobId: job.id,
      publishedBy: req.user?.email || 'admin'
    });

    res.json({
      success: true,
      publishResult
    });
  } catch (err) {
    console.error('[Worker API] Publish job error:', err.message);
    res.status(500).json({ error: 'Failed to publish rate card changes', details: err.message });
  }
});

/**
 * Cancel a queued or running job
 * POST /api/worker-jobs/:id/cancel
 */
workerJobsRouter.post('/:id/cancel', requireRole('operator', 'admin'), async (req, res) => {
  const { id } = req.params;
  const pool = getPool();
  try {
    const result = await pool.query(`
      UPDATE worker_jobs
      SET status = 'cancelled', progress_message = 'Cancelled by user', updated_at = NOW()
      WHERE id = $1 AND status IN ('queued', 'claimed', 'running')
      RETURNING *
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Job is not in a cancellable state' });
    }
    res.json({ success: true, job: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel job' });
  }
});
