export default function TabGroup({ tabs, value, onChange, className = '' }) {
  return (
    <div
      role="tablist"
      className={`inline-flex flex-wrap gap-1 rounded-xl border border-stone-200/80 bg-stone-100/90 p-1 ${className}`}
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
            className={`relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              active
                ? 'bg-surface text-[#902A4A] shadow-sm ring-1 ring-[#902A4A]/15'
                : 'text-stone-500 hover:bg-white/60 hover:text-stone-700'
            }`}
          >
            {tab.icon && <span className="text-sm leading-none opacity-80">{tab.icon}</span>}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
