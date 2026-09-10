export default function ChartCard({ title, subtitle, children, action, className = '' }) {
  const subtitleIsString = typeof subtitle === 'string';

  return (
    <div className={`chart-card bg-surface rounded-xl border border-border p-4 ${className}`}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h3 className="font-display text-headline-md font-semibold text-ink tracking-tight">{title}</h3>
          {subtitle && (
            subtitleIsString
              ? <p className="font-sans text-body-sm text-outline mt-0.5">{subtitle}</p>
              : <div className="font-sans text-body-sm text-outline mt-0.5">{subtitle}</div>
          )}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
