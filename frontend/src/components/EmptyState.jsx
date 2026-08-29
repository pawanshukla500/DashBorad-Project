import { Link } from 'react-router-dom';

/**
 * Marketplace-aware empty state with optional deep-link to Data Hub.
 */
export default function EmptyState({
  title = 'No data yet',
  message,
  marketplace,
  uploadHint,
  actionTo = '/upload',
  actionLabel = 'Open Data Hub',
}) {
  const mp = (marketplace || '').toLowerCase();
  const hint = uploadHint || (
    mp === 'amazon'
      ? 'Upload Amazon Sale Orders → Returns → Settlement in Data Hub.'
      : mp === 'flipkart'
        ? 'Upload Flipkart Sales/Orders → Returns → FK Settlement Report in Data Hub.'
        : 'Upload marketplace order and settlement files in Data Hub to populate this view.'
  );

  return (
    <div className="rounded-2xl border border-dashed border-border bg-surface-container-low/80 px-6 py-12 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface border border-border text-outline">
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
        </svg>
      </div>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 text-xs text-secondary max-w-md mx-auto">{message || hint}</p>
      <Link
        to={actionTo}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[#902A4A] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#7a2340]"
      >
        {actionLabel} →
      </Link>
    </div>
  );
}
