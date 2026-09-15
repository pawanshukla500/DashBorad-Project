import React, { useEffect, useState } from 'react';

/**
 * Global refreshing counter — useFetch bumps it when it enters the
 * stale-while-revalidate refresh phase. RefreshingBanner listens to the
 * counter so any in-flight refetch is surfaced to the user without each
 * page having to wire its own overlay.
 */
const listeners = new Set();
let refreshingCount = 0;

export function notifyRefreshingStarted() {
  refreshingCount += 1;
  listeners.forEach(l => l(refreshingCount));
  return () => notifyRefreshingFinished();
}

export function notifyRefreshingFinished() {
  refreshingCount = Math.max(0, refreshingCount - 1);
  listeners.forEach(l => l(refreshingCount));
}

function useRefreshingCount() {
  const [count, setCount] = useState(refreshingCount);
  useEffect(() => {
    listeners.add(setCount);
    return () => { listeners.delete(setCount); };
  }, []);
  return count;
}

/**
 * RefreshingBanner — small overlay pill that surfaces a stale-while-revalidate
 * refresh in progress. Mount once at app level; pairs with notifyRefreshing
 * calls in useFetch.
 */
export default function RefreshingBanner({ label = 'Refreshing data…' }) {
  const count = useRefreshingCount();
  const visible = count > 0;
  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-2 z-40 flex justify-center"
    >
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-surface/95 px-3 py-1.5 text-xs font-medium text-secondary shadow-md backdrop-blur">
        <span className="relative inline-flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
        {label}
      </div>
    </div>
  );
}
