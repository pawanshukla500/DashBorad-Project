import { useCallback, useEffect, useState } from 'react';

const CHECK_INTERVAL_MS = 30_000;

/**
 * Keeps an outage visible and understandable without replacing any verified
 * report values. The API remains responsible for the authoritative health
 * result, and requests continue retrying through the shared client.
 */
export default function ServiceStatusBanner() {
  const [available, setAvailable] = useState(null);

  const checkHealth = useCallback(async () => {
    try {
      const response = await fetch('/health', {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      setAvailable(response.ok);
    } catch {
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    void checkHealth();
    const timer = window.setInterval(() => void checkHealth(), CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [checkHealth]);

  if (available !== false) return null;

  return (
    <div
      role="status"
      aria-atomic="true"
      className="flex shrink-0 items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-amber-950 md:px-6"
    >
      <span className="material-symbols-outlined shrink-0 text-[20px]" aria-hidden="true">cloud_off</span>
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-semibold">Data service reconnecting.</span>{' '}
        Your last loaded figures remain visible. New data will load automatically when the service returns.
      </p>
      <button
        type="button"
        onClick={() => void checkHealth()}
        className="shrink-0 rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 transition-colors hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:ring-offset-2"
      >
        Check now
      </button>
    </div>
  );
}
