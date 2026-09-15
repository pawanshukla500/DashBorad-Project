import React from 'react';

/**
 * RefreshingBanner — small overlay pill that surfaces a stale-while-revalidate
 * refresh in progress. Pairs with useFetch's `refreshing` flag so pages keep
 * showing the previous dataset instead of unmounting on every refetch.
 */
export default function RefreshingBanner({ visible, label = 'Refreshing data…' }) {
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
