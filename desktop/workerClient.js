/**
 * Desktop Worker HTTPS API Client
 * 
 * Manages all communication with ReconCentral backend over secure HTTPS.
 * Eliminates direct desktop PostgreSQL credentials.
 * Hardened to prevent token leakage to untrusted local HTTP servers or non-allowlisted origins.
 */

let cachedActiveServer = null;

export const OFFICIAL_PRODUCTION_SERVERS = [
  'https://payments.youthnic.shop',
  'https://reconcentral.srv1845788.hstgr.cloud',
  'https://recon.srv1845788.hstgr.cloud'
];

export const ALLOWED_BACKEND_HOSTNAMES = new Set([
  'payments.youthnic.shop',
  'reconcentral.srv1845788.hstgr.cloud',
  'recon.srv1845788.hstgr.cloud'
]);

/**
 * Validates that an API URL targets official ReconCentral infrastructure over secure HTTPS,
 * or localhost only under explicit test / debug environment gates.
 */
export function isAllowedBackendUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    const isTestOrLocalDebug = (
      process.env.NODE_ENV === 'test' ||
      process.env.ALLOW_INSECURE_LOCAL_API === 'true'
    );

    if (isTestOrLocalDebug && parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
      return true;
    }

    return (
      parsed.protocol === 'https:' &&
      !parsed.port &&
      ALLOWED_BACKEND_HOSTNAMES.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function getCandidateServers() {
  const envUrl = process.env.API_SERVER_URL;
  const list = [];
  if (envUrl && isAllowedBackendUrl(envUrl)) {
    list.push(envUrl);
  }
  list.push(...OFFICIAL_PRODUCTION_SERVERS);
  return list;
}

export async function getActiveBackendUrl(forceProbe = false) {
  if (cachedActiveServer && !forceProbe && isAllowedBackendUrl(cachedActiveServer)) {
    return cachedActiveServer;
  }

  // Probe in parallel, without credentials. A dead alias must not hold startup
  // behind three serial timeouts. Each deadline includes response-body reading.
  const candidates = [...new Set(getCandidateServers())].filter(isAllowedBackendUrl);
  try {
    cachedActiveServer = await Promise.any(candidates.map(async server => {
      const normalized = server.replace(/\/+$/, '');
      const res = await fetch(`${normalized}/api/health`, {
        signal: AbortSignal.timeout(1000), redirect: 'error', headers: { Accept: 'application/json' }
      });
      const data = await res.json();
      if (!res.ok || data?.dataSource !== 'sql') throw new Error('Backend is not ready.');
      return normalized;
    }));
    return cachedActiveServer;
  } catch { return OFFICIAL_PRODUCTION_SERVERS[0]; }
}

export function clearCachedActiveServer() {
  cachedActiveServer = null;
}

export function getHeaders(token, targetUrl) {
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };

  // Bearer tokens are strictly isolated to verified, allowlisted HTTPS endpoints
  if (token && targetUrl && isAllowedBackendUrl(targetUrl)) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function safeFetch(url, { timeoutMs = 3000, ...options } = {}) {
  if (!isAllowedBackendUrl(url)) throw new Error('Untrusted backend URL.');
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...options, redirect: 'error' });
    if (res.status >= 502 && res.status <= 504) {
      clearCachedActiveServer();
    }
    return res;
  } catch (err) {
    clearCachedActiveServer();
    throw err;
  }
}

export async function fetchConfiguredVerticals(session, marketplace = 'both', selected = [], sellerAccount = 'default') {
  const baseUrl = await getActiveBackendUrl();
  const normalizedMarketplace = String(marketplace || 'both').trim().toLowerCase();
  const normalizedSellerAccount = String(sellerAccount || 'default').trim() || 'default';
  const channels = normalizedMarketplace === 'flipkart' ? ['flipkart'] : normalizedMarketplace === 'shopsy' ? ['shopsy'] : ['flipkart', 'shopsy'];
  // The merged /config/categories endpoint also includes vb_export_category
  // values from orders. Those master taxonomy labels are not the exact
  // Seller Hub/rate-card verticals used by FSN searches, so discover configured
  // categories from the existing typed rate-card APIs instead.
  const configTypes = ['commission', 'fixed_fee', 'collection_fee', 'pick_pack', 'reverse_shipping', 'franchise_fee'];
  const lists = await Promise.all(channels.map(async channel => {
    const tables = await Promise.all(configTypes.map(async type => {
      const query = new URLSearchParams({ marketplace: channel, seller_account: normalizedSellerAccount, active_only: 'true' });
      const res = await safeFetch(`${baseUrl}/api/rate-card/config/${type}?${query}`, {
        headers: getHeaders(session?.idToken, baseUrl)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(body.rows)) {
        throw new Error(`Configured ${channel} rate-card table '${type}' unavailable (HTTP ${res.status}). Extraction was not started because full category coverage cannot be verified.`);
      }
      return body.rows.map(row => String(row?.category || '').trim()).filter(Boolean);
    }));
    return [...new Set(tables.flat())]
      .filter(category => channel !== 'flipkart' || !category.toLowerCase().startsWith('shopsy_'))
      .map(category => channel === 'shopsy' && !category.toLowerCase().startsWith('shopsy_') ? `shopsy_${category}` : category);
  }));
  const result = [...new Set([...selected, ...lists.flat()])];
  if (!result.every(v => typeof v === 'string' && v.trim())) throw new Error('Invalid configured vertical.');
  return result;
}

export async function registerWorkerWithBackend(session, workerInfo) {
  const baseUrl = await getActiveBackendUrl();
  const res = await safeFetch(`${baseUrl}/api/workers/register`, {
    method: 'POST',
    headers: getHeaders(session?.idToken, baseUrl),
    body: JSON.stringify(workerInfo)
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Worker registration failed with HTTP ${res.status}`);
  }
  return await res.json();
}

export async function sendWorkerHeartbeat(session, workerId, status = 'online') {
  const baseUrl = await getActiveBackendUrl();
  const res = await safeFetch(`${baseUrl}/api/workers/heartbeat`, {
    method: 'POST',
    headers: getHeaders(session?.idToken, baseUrl),
    body: JSON.stringify({ id: workerId, status })
  });

  if (!res.ok) throw new Error(`Heartbeat failed: HTTP ${res.status}`);
  return await res.json();
}

export async function claimNextWorkerJob(session, workerId) {
  const baseUrl = await getActiveBackendUrl();
  const res = await safeFetch(`${baseUrl}/api/workers/jobs/claim`, {
    method: 'POST',
    headers: getHeaders(session?.idToken, baseUrl),
    body: JSON.stringify({ worker_id: workerId })
  });

  if (!res.ok) throw new Error(`Claim job failed: HTTP ${res.status}`);
  return await res.json();
}

export async function releaseClaimedWorkerJob(session, job, workerId) {
  if (!job?.id || !workerId) throw new Error('Job and worker identifiers are required to release a claim.');
  const baseUrl = await getActiveBackendUrl();
  const res = await safeFetch(`${baseUrl}/api/workers/jobs/release`, {
    method: 'POST',
    headers: getHeaders(session?.idToken, baseUrl),
    body: JSON.stringify({ job_id: job.id, worker_id: workerId })
  });
  if (!res.ok) throw new Error(`Release claimed job failed: HTTP ${res.status}`);
  return await res.json();
}

export async function reportJobProgress(session, jobId, progressPct, progressMessage) {
  const baseUrl = await getActiveBackendUrl();
  const res = await safeFetch(`${baseUrl}/api/worker-jobs/${jobId}/progress`, {
    method: 'POST',
    headers: getHeaders(session?.idToken, baseUrl),
    body: JSON.stringify({ progress_pct: progressPct, progress_message: progressMessage })
  });

  if (!res.ok) throw new Error(`Progress report failed: HTTP ${res.status}`);
  return await res.json();
}

export async function reportJobFailure(session, jobId, errorMessage, errorCode = 'SCRAPE_ERROR', workerId = null) {
  const baseUrl = await getActiveBackendUrl();
  const res = await safeFetch(`${baseUrl}/api/worker-jobs/${jobId}/fail`, {
    method: 'POST',
    headers: getHeaders(session?.idToken, baseUrl),
    body: JSON.stringify({ error_message: errorMessage, error_code: errorCode, worker_id: workerId })
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Report failure failed: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function submitJobResults(session, jobId, results, workerId = null, isCurrent = () => true) {
  const baseUrl = await getActiveBackendUrl();
  if (!isCurrent()) throw new Error('The account changed during extraction. Results were not submitted.');
  let res;
  try {
    res = await safeFetch(`${baseUrl}/api/worker-jobs/${jobId}/results`, {
      timeoutMs: 30000,
      method: 'POST',
      headers: getHeaders(session?.idToken, baseUrl),
      body: JSON.stringify({ results, worker_id: workerId })
    });
  } catch (error) {
    if (isCurrent()) throw error;
    await discardWorkerJobResults(session, jobId, workerId, 'Signed-in account changed while extraction results were being submitted');
    throw new Error('The account changed during extraction. Results were discarded and cannot be published.');
  }

  if (!isCurrent()) {
    await discardWorkerJobResults(session, jobId, workerId, 'Signed-in account changed while extraction results were being submitted');
    throw new Error('The account changed during extraction. Results were discarded and cannot be published.');
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Submit results failed: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function discardWorkerJobResults(session, jobId, workerId = null, reason = 'Desktop extraction was not accepted') {
  const baseUrl = await getActiveBackendUrl();
  const res = await safeFetch(`${baseUrl}/api/worker-jobs/${jobId}/discard-results`, {
    method: 'POST', headers: getHeaders(session?.idToken, baseUrl),
    body: JSON.stringify({ worker_id: workerId, reason })
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Discard results failed: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function fetchBrandCatalogFromApi(session, { marketplace, sellerAccount } = {}) {
  const baseUrl = await getActiveBackendUrl();
  const query = new URLSearchParams();
  const normalizedMarketplace = String(marketplace || '').trim().toLowerCase();
  if (normalizedMarketplace === 'flipkart' || normalizedMarketplace === 'shopsy') {
    query.set('marketplace', normalizedMarketplace);
  }
  if (sellerAccount !== undefined && sellerAccount !== null) {
    query.set('seller_account', String(sellerAccount || 'default').trim() || 'default');
  }
  const suffix = query.toString();
  const res = await safeFetch(`${baseUrl}/api/rate-card/brand-fsn-catalog${suffix ? `?${suffix}` : ''}`, {
    timeoutMs: 30000,
    method: 'GET',
    headers: getHeaders(session?.idToken, baseUrl)
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Fetch catalog failed: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function detectRateChangesViaApi(session, scrapedObservations, marketplace = 'flipkart', sellerAccount = 'default') {
  const baseUrl = await getActiveBackendUrl();
  const res = await safeFetch(`${baseUrl}/api/rate-card/detect-changes`, {
    timeoutMs: 30000,
    method: 'POST',
    headers: getHeaders(session?.idToken, baseUrl),
    body: JSON.stringify({ scrapedData: scrapedObservations, marketplace, seller_account: sellerAccount })
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Detect changes failed: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function reviewRatesViaApi(session, cards, sellerAccount = 'default') {
  const cardAccounts = [...new Set(cards.map(card => card.seller_account).filter(Boolean))];
  if (cardAccounts.length > 1 || (cardAccounts.length === 1 && cardAccounts[0] !== sellerAccount)) {
    throw new Error('Review one seller account at a time, matching the account on the rate cards.');
  }
  const changes = [], fingerprints = {};
  const types = { rc_commission: 'commission', rc_fixed_fee: 'fixed_fee', rc_collection_fee: 'collection_fee', rc_reverse_shipping: 'reverse_shipping', rc_pick_pack: 'pick_pack' };
  for (const marketplace of [...new Set(cards.map(c => c.marketplace))]) {
    const result = await detectRateChangesViaApi(session, cards.filter(c => c.marketplace === marketplace), marketplace, sellerAccount);
    if (!result.fingerprint) throw new Error('Backend review contract is unavailable; publication is disabled.');
    fingerprints[marketplace] = result.fingerprint;
    for (const diff of result.diffs) changes.push({ ...diff, marketplace, brand: diff.brand_name || 'General', type: types[diff.table], reason: diff.details,
      fulfilmentType: diff.fulfilment_type, weightSlab: (diff.newRow || diff.oldRow)?.weight_slab,
      priceMin: (diff.newRow || diff.oldRow)?.price_min, priceMax: (diff.newRow || diff.oldRow)?.price_max,
      weightMin: (diff.newRow || diff.oldRow)?.weight_min, weightMax: (diff.newRow || diff.oldRow)?.weight_max });
  }
  return { changes, fingerprints, changesCount: changes.length, anomaliesCount: changes.filter(c => c.anomaly).length };
}

export async function publishReviewedRatesViaApi(session, cards, fingerprints, sellerAccount = 'default', isCurrent = () => true) {
  if (!isCurrent()) throw new Error('The signed-in account changed. Rate publication was cancelled.');
  if (session?.user?.role !== 'admin') throw new Error('An admin must approve publication.');
  const channels = [...new Set(cards.map(c => c.marketplace))];
  if (channels.length !== 1) throw new Error('Review and publish one marketplace at a time.');
  const marketplace = channels[0];
  if (!fingerprints?.[marketplace]) throw new Error('Review the current PostgreSQL comparison before publication.');
  const base = await getActiveBackendUrl();
  const created = await safeFetch(`${base}/api/worker-jobs`, { method: 'POST', headers: getHeaders(session.idToken, base),
    body: JSON.stringify({ marketplace, seller_account: sellerAccount, job_type: 'RATE_CARD_SYNC',
      parameters: { verticals: cards.map(c => c.category), reviewFingerprint: fingerprints[marketplace] } }) });
  const body = await created.json();
  if (!created.ok || !body.job) throw new Error(body.error || 'Review job could not be created.');
  try {
    await submitJobResults(session, body.job.id, cards, null, isCurrent);
    if (!isCurrent()) throw new Error('The signed-in account changed before rate publication.');
  } catch (error) {
    try {
      await discardWorkerJobResults(session, body.job.id, null, 'Reviewed rate submission failed; cancel unused sync job');
    } catch (cleanupError) {
      throw new Error(`${error.message}; the unused sync job could not be cancelled: ${cleanupError.message}`);
    }
    throw error;
  }
  const result = await publishJobViaApi(session, body.job.id);
  return { updated: result.publishResult.published, changesCount: result.publishResult.diffCount,
    versionName: result.publishResult.versionName, message: result.publishResult.message };
}

export async function publishJobViaApi(session, jobId) {
  const baseUrl = await getActiveBackendUrl();
  const res = await safeFetch(`${baseUrl}/api/worker-jobs/${jobId}/publish`, {
    timeoutMs: 65000,
    method: 'POST',
    headers: getHeaders(session?.idToken, baseUrl)
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Publish failed: HTTP ${res.status}`);
  }
  return await res.json();
}
