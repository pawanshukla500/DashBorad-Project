export default function ChartCard({ title, subtitle, children, action, className = '' }) {
  const subtitleIsString = typeof subtitle === 'string';

  return (
    <div className={`chart-card bg-surface rounded-2xl border border-border p-5 sm:p-6 shadow-sm hover:shadow-md transition-shadow duration-300 ${className}`}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h3 className="font-headline-sm text-headline-sm font-bold text-ink tracking-tight">{title}</h3>
          {subtitle && (
            subtitleIsString
              ? <p className="font-body-sm text-body-sm text-outline mt-0.5">{subtitle}</p>
              : <div className="font-body-sm text-body-sm text-outline mt-0.5">{subtitle}</div>
          )}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
