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
    <div className="rounded-xl border border-dashed border-border bg-surface-container-low/80 px-6 py-12 text-center" role="status" aria-live="polite">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface border border-border text-outline">
        <span className="material-symbols-outlined text-[24px]" aria-hidden="true">database_upload</span>
      </div>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 text-xs text-secondary max-w-md mx-auto">{message || hint}</p>
      <Link
        to={actionTo}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-bold text-on-primary transition-colors hover:bg-indigo-dark focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2"
      >
        {actionLabel}
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">arrow_forward</span>
      </Link>
    </div>
  );
}
