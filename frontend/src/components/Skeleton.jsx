import React from 'react';

/**
 * Skeleton — minimal, token-driven loading placeholder.
 * Matches ReconCentral surface tokens so the layout does not shift when real
 * content arrives.
 */

export function SkeletonBlock({ className = '', rounded = 'rounded-md' }) {
  return (
    <div
      className={`animate-pulse bg-surface-container-low ${rounded} ${className}`}
      aria-hidden="true"
    />
  );
}

export function SkeletonText({ width = 'w-full', height = 'h-3', className = '' }) {
  return <SkeletonBlock className={`${width} ${height} ${className}`} />;
}

export function SkeletonKpiCard() {
  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-sm">
      <SkeletonText width="w-1/3" height="h-2.5" />
      <SkeletonText width="w-3/4" height="h-6" className="mt-3" />
      <SkeletonText width="w-1/2" height="h-2.5" className="mt-2" />
    </div>
  );
}

export function SkeletonKpiGrid({ count = 4 }) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonKpiCard key={i} />
      ))}
    </div>
  );
}

export function SkeletonChart({ height = 'h-64', className = '' }) {
  return (
    <div className={`rounded-xl border border-border bg-surface ${height} p-4 shadow-sm ${className}`}>
      <SkeletonText width="w-1/4" height="h-3" />
      <SkeletonBlock className={`mt-4 h-[calc(100%-2rem)] ${height.replace('h-','')} bg-surface-container-low`} />
    </div>
  );
}

export function SkeletonTable({ rows = 6 }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="border-b border-border bg-surface-container-low px-4 py-3">
        <SkeletonText width="w-1/4" height="h-3" />
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3">
            <SkeletonText width="w-1/6" height="h-3" />
            <SkeletonText width="w-1/4" height="h-3" />
            <SkeletonText width="w-1/5" height="h-3" />
            <SkeletonText width="w-1/6" height="h-3" />
            <SkeletonText width="w-1/12" height="h-3" className="ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}
