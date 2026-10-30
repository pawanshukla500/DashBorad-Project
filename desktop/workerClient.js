/**
 * Desktop Worker HTTPS API Client
 * 
 * Manages all communication with ReconCentral backend over secure HTTPS.
 * Eliminates direct desktop PostgreSQL credentials.
 */

let cachedActiveServer = null;

export const CANDIDATE_SERVERS = [
  process.env.API_SERVER_URL,
  'https://payments.youthnic.shop',
  'https://reconcentral.srv1845788.hstgr.cloud',
  'https://recon.srv1845788.hstgr.cloud',
  'http://localhost:5000',
  'http://localhost:3001'
].filter(Boolean);

export async function getActiveBackendUrl(forceProbe = false) {
  if (cachedActiveServer && !forceProbe) return cachedActiveServer;

  for (const serverBase of CANDIDATE_SERVERS) {
    const normalized = serverBase.replace(/\/+$/, '').replace('payment.youthnic.shop', 'payments.youthnic.shop');
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${normalized}/api/health`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      }).finally(() => clearTimeout(timer));

      if (res.ok) {
        cachedActiveServer = normalized;
        return normalized;
      }
    } catch {
      // Try next candidate
    }
  }

  // Fallback to default
  return CANDIDATE_SERVERS[0] || 'https://payments.youthnic.shop';
}

function getHeaders(token) {
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

export async function registerWorkerWithBackend(session, workerInfo) {
  const baseUrl = await getActiveBackendUrl();
  const res = await fetch(`${baseUrl}/api/workers/register`, {
    method: 'POST',
    headers: getHeaders(session?.idToken),
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
  const res = await fetch(`${baseUrl}/api/workers/heartbeat`, {
    method: 'POST',
    headers: getHeaders(session?.idToken),
    body: JSON.stringify({ id: workerId, status })
  });

  if (!res.ok) throw new Error(`Heartbeat failed: HTTP ${res.status}`);
  return await res.json();
}

export async function claimNextWorkerJob(session, workerId) {
  const baseUrl = await getActiveBackendUrl();
  const res = await fetch(`${baseUrl}/api/workers/jobs/claim`, {
    method: 'POST',
    headers: getHeaders(session?.idToken),
    body: JSON.stringify({ worker_id: workerId })
  });

  if (!res.ok) throw new Error(`Claim job failed: HTTP ${res.status}`);
  return await res.json();
}

export async function reportJobProgress(session, jobId, progressPct, progressMessage) {
  const baseUrl = await getActiveBackendUrl();
  const res = await fetch(`${baseUrl}/api/worker-jobs/${jobId}/progress`, {
    method: 'POST',
    headers: getHeaders(session?.idToken),
    body: JSON.stringify({ progress_pct: progressPct, progress_message: progressMessage })
  });

  if (!res.ok) throw new Error(`Progress report failed: HTTP ${res.status}`);
  return await res.json();
}

export async function submitJobResults(session, jobId, results) {
  const baseUrl = await getActiveBackendUrl();
  const res = await fetch(`${baseUrl}/api/worker-jobs/${jobId}/results`, {
    method: 'POST',
    headers: getHeaders(session?.idToken),
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
  const res = await fetch(`${baseUrl}/api/rate-card/brand-fsn-catalog`, {
    method: 'GET',
    headers: getHeaders(session?.idToken)
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Fetch catalog failed: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function detectRateChangesViaApi(session, scrapedObservations, marketplace = 'flipkart') {
  const baseUrl = await getActiveBackendUrl();
  const res = await fetch(`${baseUrl}/api/rate-card/detect-changes`, {
    method: 'POST',
    headers: getHeaders(session?.idToken),
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
  const res = await fetch(`${baseUrl}/api/worker-jobs/${jobId}/publish`, {
    method: 'POST',
    headers: getHeaders(session?.idToken)
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Publish failed: HTTP ${res.status}`);
  }
  return await res.json();
}

