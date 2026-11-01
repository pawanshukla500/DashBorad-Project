import express from 'express';
import { getPool } from '../db/index.js';
import { requireRole } from '../utils/authMiddleware.js';
import { compareScrapedRatesWithActive } from '../services/rateCardCanonicalEngine.js';
import { publishRateCardObservations } from '../services/rateCardPublisher.js';
import { validateRateObservations } from '../services/rateCardObservationPlan.js';
import { assertRateObservationCoverage, loadRateCardCoverage } from '../services/rateCardCoverage.js';
import { resolveRateCardEffectiveDate } from '../utils/rateCardDate.js';

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

/**
 * Return a claim that arrived after the desktop worker was stopped.
 * POST /api/workers/jobs/release
 */
workersRouter.post('/jobs/release', async (req, res) => {
  const { job_id, worker_id } = req.body;
  if (!job_id || !worker_id) return res.status(400).json({ error: 'Job id and worker id are required' });
  try {
    const result = await getPool().query(`
      UPDATE worker_jobs
      SET status = 'queued', lease_worker_id = NULL, lease_expires_at = NULL,
          attempts = GREATEST(attempts - 1, 0), progress_pct = 0,
          progress_message = 'Queued after worker stopped before extraction', updated_at = NOW()
      WHERE id = $1 AND lease_worker_id = $2 AND status = 'claimed'
      RETURNING id, status
    `, [job_id, worker_id]);
    if (result.rows.length === 0) return res.status(409).json({ error: 'Claim is no longer held by this worker', code: 'LEASE_MISMATCH' });
    res.json({ success: true, job: result.rows[0] });
  } catch (err) {
    console.error('[Worker API] Release claim error:', err.message);
    res.status(500).json({ error: 'Failed to release worker claim' });
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
  const { status, marketplace, job_type, limit = 50 } = req.query;
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
    if (job_type) {
      conditions.push(`job_type = $${idx++}`);
      params.push(job_type);
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

    if (!['RATE_CARD_SCRAPE', 'RATE_CARD_SYNC'].includes(job.job_type)) {
      return res.status(400).json({ error: 'This worker job does not accept rate-card observations.', code: 'UNSUPPORTED_JOB_TYPE' });
    }

    // If assigned to a worker lease, strictly enforce lease ownership and expiry
    if (job.lease_worker_id) {
      if (!worker_id || job.lease_worker_id !== worker_id) {
        return res.status(409).json({ error: 'Job lease belongs to another worker or lease has expired', code: 'LEASE_MISMATCH' });
      }
      if (job.lease_expires_at && new Date(job.lease_expires_at) < new Date()) {
        return res.status(409).json({ error: 'Job lease has expired', code: 'LEASE_EXPIRED' });
      }
    }

    // Use the extraction's effective date for both category discovery and the
    // active-rate comparison. CURRENT_DATE can disagree with UTC at midnight.
    let scrapeEffectiveDate;
    try {
      scrapeEffectiveDate = resolveRateCardEffectiveDate(effective_date ||
        results.find(r => r.effectiveDate)?.effectiveDate ||
        results.find(r => r.source_effective_date)?.source_effective_date ||
        job.parameters?.effectiveDate);
      if (results.some(row => (row.effectiveDate || row.source_effective_date) &&
          (row.effectiveDate || row.source_effective_date) !== scrapeEffectiveDate)) {
        throw Object.assign(new Error('All rate observations must share one effective date.'), { code: 'INVALID_EFFECTIVE_DATE', status: 400 });
      }
    } catch (err) {
      return res.status(400).json({ error: err.message, code: err.code || 'INVALID_EFFECTIVE_DATE' });
    }

    // Store the resolved date with every observation. Review and publish read
    // the saved payload later, so they must not infer a different date from
    // job timestamps after midnight or when only source_effective_date arrived.
    const normalizedResults = results.map(row => ({ ...row, effectiveDate: scrapeEffectiveDate }));

    let coverage;
    let expectedVerticals;
    try {
      // Coverage comes from this marketplace/account's real PostgreSQL
      // configuration and FSN catalog. Job parameters are client supplied and
      // must never be allowed to narrow the completeness requirement.
      coverage = await loadRateCardCoverage(pool, { marketplace: job.marketplace, sellerAccount: job.seller_account, effectiveDate: scrapeEffectiveDate });
      expectedVerticals = assertRateObservationCoverage(normalizedResults, coverage);
      validateRateObservations(normalizedResults, { marketplace: job.marketplace, complete: true,
        expectedVerticals });
    } catch (err) {
      console.warn('[Worker API] Rate-card extraction rejected', JSON.stringify({
        event: 'worker_rate_card_coverage_rejected', jobId: id,
        marketplace: job.marketplace, sellerAccount: job.seller_account,
        code: err.code || 'INCOMPLETE_EXTRACTION', message: err.message,
      }));
      return res.status(err.code === 'RATE_CARD_COVERAGE_UNAVAILABLE' ? 503 : 400)
        .json({ error: err.message, code: err.code || 'INCOMPLETE_EXTRACTION' });
    }

    // Run canonical diff engine against active PostgreSQL rate cards
    const diffResult = await compareScrapedRatesWithActive(normalizedResults, {
      marketplace: job.marketplace,
      sellerAccount: job.seller_account,
      effectiveDate: scrapeEffectiveDate
    });
    diffResult.coverage = {
      configuredCategories: coverage.configuredCategories,
      fsnCategories: coverage.fsnCategories,
      fsnBackedConfiguredCategories: coverage.fsnBackedConfiguredCategories,
      missingFsnCategories: coverage.missingFsnCategories,
      configuredCategoriesWithoutOrders: coverage.configuredCategoriesWithoutOrders,
      configuredCategoriesWithOrdersButNoFsns: coverage.configuredCategoriesWithOrdersButNoFsns,
      complete: true,
    };
    if (job.parameters?.reviewFingerprint && job.parameters.reviewFingerprint !== diffResult.fingerprint) {
      return res.status(409).json({ error: 'Rates changed since desktop review. Refresh and review again.', code: 'REVIEW_STALE' });
    }

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
    `, [JSON.stringify(normalizedResults), JSON.stringify(diffResult), id, worker_id]);

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
 * Discard extraction results after the desktop account changes or delivery
 * fails. This also cancels queued sync jobs so they cannot remain stranded.
 * POST /api/worker-jobs/:id/discard-results
 */
workerJobsRouter.post('/:id/discard-results', async (req, res) => {
  const { id } = req.params;
  const { worker_id = null, reason = 'Desktop session changed before review' } = req.body || {};
  const pool = getPool();
  try {
    const result = await pool.query(`
      UPDATE worker_jobs
      SET status = 'cancelled', results = NULL, diff_summary = NULL,
          progress_pct = 0, progress_message = 'Extraction results discarded',
          error_code = 'RESULTS_DISCARDED', error_message = $4,
          completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
      WHERE id = $1 AND job_type IN ('RATE_CARD_SCRAPE', 'RATE_CARD_SYNC')
        AND status IN ('queued', 'claimed', 'running', 'completed')
        AND ((lease_worker_id IS NOT NULL AND lease_worker_id = $2)
          OR (lease_worker_id IS NULL AND created_by = $3))
      RETURNING id, status
    `, [id, worker_id, req.user?.email || null, String(reason).slice(0, 500)]);
    if (result.rows.length) return res.json({ success: true, discarded: true, job: result.rows[0] });

    const existing = await pool.query(`SELECT id, status, lease_worker_id, created_by FROM worker_jobs WHERE id = $1`, [id]);
    const job = existing.rows[0];
    const ownsCancelledJob = job?.status === 'cancelled' &&
      (job.lease_worker_id ? job.lease_worker_id === worker_id : job.created_by === req.user?.email);
    if (ownsCancelledJob) return res.json({ success: true, discarded: true, alreadyDiscarded: true, job });
    return res.status(409).json({ error: 'Job is no longer discardable by this desktop session', code: 'JOB_NOT_OWNED_OR_ACTIVE' });
  } catch (err) {
    console.error('[Worker API] Discard results error:', err.message);
    return res.status(500).json({ error: 'Failed to discard worker job results' });
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
    if (job.status !== 'completed') return res.status(409).json({ error: 'Only completed, reviewed extractions can be published.' });
    if (!['RATE_CARD_SCRAPE', 'RATE_CARD_SYNC'].includes(job.job_type)) {
      return res.status(400).json({ error: 'This worker job is not a rate-card extraction.', code: 'UNSUPPORTED_JOB_TYPE' });
    }
    if (!job.results || !Array.isArray(job.results)) {
      return res.status(400).json({ error: 'Job does not contain valid extraction results to publish' });
    }

    const effectiveDate = resolveRateCardEffectiveDate(req.body?.effectiveDate ||
      job.diff_summary?.effectiveDate ||
      job.results.find(r => r.effectiveDate || r.source_effective_date)?.effectiveDate ||
      job.results.find(r => r.source_effective_date)?.source_effective_date ||
      job.parameters?.effectiveDate ||
      (job.completed_at ? new Date(job.completed_at).toISOString().slice(0, 10) : null) ||
      (job.created_at ? new Date(job.created_at).toISOString().slice(0, 10) : null) ||
      new Date().toISOString().slice(0, 10));

    const coverage = await loadRateCardCoverage(pool, { marketplace: job.marketplace, sellerAccount: job.seller_account, effectiveDate });
    const expectedVerticals = assertRateObservationCoverage(job.results, coverage);
    validateRateObservations(job.results, { marketplace: job.marketplace, complete: true, expectedVerticals });

    const publishResult = await publishRateCardObservations(job.results, {
      marketplace: job.marketplace,
      sellerAccount: job.seller_account,
      effectiveDate,
      jobId: job.id,
      publishedBy: req.user?.email,
      requireConfiguredCoverage: true,
      reviewFingerprint: job.diff_summary?.fingerprint
    });

    res.json({
      success: true,
      publishResult
    });
  } catch (err) {
    console.error('[Worker API] Publish job error:', err.message);
    const status = err.code === 'RATE_CARD_COVERAGE_UNAVAILABLE' ? 503
      : ['RATE_CARD_COVERAGE_INCOMPLETE', 'RATE_CARD_NO_FSN_BACKED_CATEGORIES'].includes(err.code) ? 409
        : err.code === 'INVALID_EFFECTIVE_DATE' ? 400 : 500;
    res.status(status).json({ error: 'Failed to publish rate card changes', details: err.message, code: err.code });
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
