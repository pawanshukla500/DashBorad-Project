export default function PageHeader({ title, subtitle, children }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 page-header">
      <div className="flex-1 min-w-0">
        <h1 className="font-headline-md text-headline-md font-bold text-ink tracking-tight">{title}</h1>
        {subtitle && <p className="font-body-sm text-body-sm text-outline mt-0.5">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-2 shrink-0">{children}</div>}
    </div>
  );
}
