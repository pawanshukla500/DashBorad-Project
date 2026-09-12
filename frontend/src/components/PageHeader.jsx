export default function PageHeader({ title, subtitle, children }) {
  if (!title && !subtitle && !children) return null;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center page-header">
      {(title || subtitle) && (
        <div className="flex-1 min-w-0">
          {title && (
            <h1 className="font-display text-headline-lg font-semibold text-ink">{title}</h1>
          )}
          {subtitle && <p className="font-sans text-body-sm text-outline mt-0.5 max-w-[68ch]">{subtitle}</p>}
        </div>
      )}
      {children && <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:justify-end">{children}</div>}
    </div>
  );
}
