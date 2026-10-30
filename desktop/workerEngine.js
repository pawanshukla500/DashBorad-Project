// Fast control-plane work is independent of the sequential portal action lane.
export function createWorkerEngine({ getSession, register, heartbeat, claim, execute, isBusy = () => false, log = console.log, intervalMs = 2000 }) {
  let generation = 0, timer, heartTimer, inFlight = false, running = false, registered = false;
  const stop = () => { generation++; clearInterval(timer); clearInterval(heartTimer); timer = heartTimer = null; registered = false; };
  const start = async () => {
    if (timer) return;
    stop();
    const owner = generation, started = Date.now();
    const tick = async () => {
      if (owner !== generation || inFlight || running || isBusy()) return;
      inFlight = true;
      try {
        const session = await getSession();
        if (!session?.idToken || owner !== generation) return;
        if (!registered) { await register(session); if (owner !== generation) return; registered = true; }
        const response = await claim(session);
        if (owner !== generation) return;
        log({ event: 'worker_poll', startupElapsedMs: Date.now() - started });
        if (response?.success && response.job) {
          running = true;
          Promise.resolve().then(() => execute(session, response.job)).catch(error => log({ event: 'worker_job_failed', message: error.message }))
            .finally(() => { running = false; });
        }
      } catch (error) {
        registered = false;
        log({ event: 'worker_poll_failed', message: error.message });
      } finally { inFlight = false; }
    };
    timer = setInterval(tick, intervalMs);
    heartTimer = setInterval(async () => {
      if (owner !== generation || !registered) return;
      try {
        const session = await getSession();
        if (session?.idToken && owner === generation) await heartbeat(session, running ? 'busy' : 'online');
      } catch (error) { log({ event: 'worker_heartbeat_failed', message: error.message }); }
    }, 25000);
    await tick();
  };
  return { start, stop, get active() { return Boolean(timer); } };
}
