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

  const candidates = getCandidateServers();
  for (const serverBase of candidates) {
    if (!isAllowedBackendUrl(serverBase)) continue;
    const normalized = serverBase.replace(/\/+$/, '').replace('payment.youthnic.shop', 'payments.youthnic.shop');
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(`${normalized}/api/health`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      }).finally(() => clearTimeout(timer));

      if (res.ok) {
        const data = await res.json().catch(() => null);
        // Ensure response is authentic ReconCentral service
        if (data && data.dataSource === 'sql') {
          cachedActiveServer = normalized;
          return normalized;
        }
      }
    } catch {
      // Try next candidate
    }
  }

  // Fallback to primary production domain
  return OFFICIAL_PRODUCTION_SERVERS[0];
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

async function safeFetch(url, options = {}) {
  try {
    const res = await fetch(url, options);
    if (res.status >= 502 && res.status <= 504) {
      clearCachedActiveServer();
    }
    return res;
  } catch (err) {
    clearCachedActiveServer();
    throw err;
  }
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

export async function submitJobResults(session, jobId, results) {
  const baseUrl = await getActiveBackendUrl();
  const res = await safeFetch(`${baseUrl}/api/worker-jobs/${jobId}/results`, {
    method: 'POST',
    headers: getHeaders(session?.idToken, baseUrl),
    body: JSON.stringify({ results })
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Submit results failed: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function fetchBrandCatalogFromApi(session) {
  const baseUrl = await getActiveBackendUrl();
  const res = await safeFetch(`${baseUrl}/api/rate-card/brand-fsn-catalog`, {
    method: 'GET',
    headers: getHeaders(session?.idToken, baseUrl)
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Fetch catalog failed: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function detectRateChangesViaApi(session, scrapedObservations, marketplace = 'flipkart') {
  const baseUrl = await getActiveBackendUrl();
  const res = await safeFetch(`${baseUrl}/api/rate-card/detect-changes`, {
    method: 'POST',
    headers: getHeaders(session?.idToken, baseUrl),
    body: JSON.stringify({ scrapedData: scrapedObservations, marketplace })
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Detect changes failed: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function publishJobViaApi(session, jobId) {
  const baseUrl = await getActiveBackendUrl();
  const res = await safeFetch(`${baseUrl}/api/worker-jobs/${jobId}/publish`, {
    method: 'POST',
    headers: getHeaders(session?.idToken, baseUrl)
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Publish failed: HTTP ${res.status}`);
  }
  return await res.json();
}
