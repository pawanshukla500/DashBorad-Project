export default function TabGroup({ tabs, value, onChange, className = '', label = 'Section tabs' }) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={`inline-flex flex-wrap gap-1 rounded-xl border border-border bg-surface-container-low p-1 ${className}`}
    >
      {tabs.map(tab => {
        const active = value === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={`relative flex min-h-8 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all focus-visible:ring-2 focus-visible:ring-primary/40 ${
              active
                ? 'bg-surface text-primary shadow-sm ring-1 ring-primary/15'
                : 'text-secondary hover:bg-surface hover:text-ink'
            }`}
          >
            {tab.icon && <span className="text-sm leading-none opacity-80" aria-hidden="true">{tab.icon}</span>}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
