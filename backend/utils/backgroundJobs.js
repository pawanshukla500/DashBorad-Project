// Background imports that keep running after their HTTP response (Flipkart
// settlement workbooks, Amazon settlement files). Graceful shutdown waits for
// them before closing the database pool; otherwise a deploy cut an import that
// would have finished within the drain window, leaving totals stale and no
// upload_log row.
const active = new Set();

/** Run `task` on the next tick, tracked until it settles. Errors are logged. */
export function runInBackground(label, task) {
  const job = new Promise(resolve => setImmediate(resolve))
    .then(task)
    .catch(error => console.error(`[background:${label}]`, error?.message || error))
    .finally(() => active.delete(job));
  active.add(job);
  return job;
}

export function activeBackgroundJobs() {
  return active.size;
}

/**
 * Wait until every tracked job settles or `timeoutMs` passes. Resolves with
 * the number of jobs still running (0 when all finished).
 */
export async function waitForBackgroundJobs(timeoutMs) {
  if (!active.size) return 0;
  let timer;
  const timedOut = new Promise(resolve => {
    timer = setTimeout(resolve, Math.max(0, timeoutMs));
    timer.unref?.();
  });
  await Promise.race([Promise.allSettled([...active]), timedOut]);
  clearTimeout(timer);
  return active.size;
}
