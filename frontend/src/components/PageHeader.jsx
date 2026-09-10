export default function PageHeader({ title, subtitle, children }) {
  if (!title && !subtitle && !children) return null;

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 page-header">
      {(title || subtitle) && (
        <div className="flex-1 min-w-0">
          {title && (
            <h1 className="font-display text-headline-lg font-semibold text-ink tracking-tight">{title}</h1>
          )}
          {subtitle && <p className="font-sans text-body-sm text-outline mt-0.5 max-w-[68ch]">{subtitle}</p>}
        </div>
      )}
      {children && <div className="flex items-center gap-2 shrink-0 sm:ml-auto">{children}</div>}
    </div>
  );
}
