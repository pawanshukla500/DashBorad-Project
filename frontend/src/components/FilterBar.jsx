import { useEffect, useState, useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useFilters } from '../context/FilterContext';
import { fetchFilters } from '../api/client';
import { filtersForPath } from '../navigation';

const MARKETPLACES = [
  { id: '',          label: 'All' },
  { id: 'flipkart',  label: 'Flipkart' },
  { id: 'amazon',    label: 'Amazon' },
  { id: 'myntra_vb', label: 'Myntra (VB)' },
  { id: 'myntra_ej', label: 'Myntra (EJ)' },
  { id: 'meesho',    label: 'Meesho' },
  { id: 'ajio',      label: 'Ajio' },
];

const MP_ACTIVE = {
  '':          'bg-ink text-surface border-ink shadow-sm',
  flipkart:    'bg-[#0456C8] text-white border-[#0456C8] shadow-sm',
  amazon:      'bg-[#FF9900] text-black border-[#FF9900] shadow-sm',
  myntra:      'bg-[#F13AB1] text-white border-[#F13AB1] shadow-sm',
  myntra_vb:   'bg-[#F13AB1] text-white border-[#F13AB1] shadow-sm',
  myntra_ej:   'bg-[#BE185D] text-white border-[#BE185D] shadow-sm',
  meesho:      'bg-[#F43397] text-white border-[#F43397] shadow-sm',
  ajio:        'bg-[#2C4152] text-white border-[#2C4152] shadow-sm',
};

function fmtTime(d) {
  if (!d) return null;
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
}

export default function FilterBar() {
  const { pathname } = useLocation();
  const contract = useMemo(() => filtersForPath(pathname), [pathname]);
  const filtersShown = contract.marketplace || contract.dates || contract.groupBy || contract.advanced;

  const {
    filters, updateFilter, resetFilters, refreshKey, triggerRefresh,
    savedViews, saveView, applyView, deleteView,
  } = useFilters();
  const [opts, setOpts]             = useState({ categories: [], regions: [], statuses: [], brands: [] });
  const [spinning, setSpinning]     = useState(false);
  const [lastSynced, setLastSynced] = useState(null);
  const [showMore, setShowMore]     = useState(false);
  const [viewName, setViewName]     = useState('');
  const [selectedView, setSelectedView] = useState('');

  const hasAdvancedFilters = !!(filters.category || filters.region || filters.status || filters.brand);

  const doRefresh = useCallback(() => {
    triggerRefresh();
    setLastSynced(new Date());
  }, [triggerRefresh]);

  const handleRefresh = useCallback(() => {
    if (spinning) return;
    setSpinning(true);
    doRefresh();
    setTimeout(() => setSpinning(false), 1200);
  }, [doRefresh, spinning]);

  useEffect(() => { setLastSynced(new Date()); }, []);

  useEffect(() => {
    if (!filtersShown) return;
    fetchFilters(refreshKey).then(setOpts).catch(() => {});
  }, [refreshKey, filtersShown]);

  if (!filtersShown) return null;

  const sel = 'font-sans text-body-sm border border-border rounded-lg px-2.5 py-1.5 text-ink bg-surface focus:outline-none focus:ring-2 focus:ring-primary/40 hover:border-outline transition-colors min-w-0';
  const advancedId = 'advanced-filters';

  return (
    <section className="border-t border-border" aria-label="Page filters">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 sm:px-6">
        {contract.marketplace && (
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Marketplace filter">
            {MARKETPLACES.map(mp => {
              const isActive = filters.marketplace === mp.id;
              return (
                <button
                  key={mp.id}
                  type="button"
                  onClick={() => { updateFilter('marketplace', mp.id); if (mp.id === 'meesho') updateFilter('brand', ''); }}
                  aria-pressed={isActive}
                  className={`rounded-full border px-3 py-1 font-sans text-label-md uppercase transition-all focus-visible:ring-2 focus-visible:ring-primary/40 ${
                    isActive
                      ? (MP_ACTIVE[mp.id] || MP_ACTIVE[''])
                      : 'bg-surface text-secondary border-border hover:border-outline hover:text-ink'
                  }`}
                >
                  {mp.label}
                </button>
              );
            })}
          </div>
        )}

        {contract.marketplace && contract.dates && (
          <span className="hidden sm:block w-px h-5 bg-surface-container-high" />
        )}

        {contract.dates && (
          <div className="flex min-w-0 items-center overflow-hidden rounded-lg border border-border bg-surface transition-colors hover:border-border focus-within:ring-2 focus-within:ring-primary/50" role="group" aria-label="Date range filter">
            <div className="pl-2.5 pr-1.5 py-1 bg-surface-container-low border-r border-border">
              <span className="material-symbols-outlined text-[16px] text-outline" aria-hidden="true">calendar_month</span>
            </div>
            <input type="date" value={filters.startDate} onChange={e => updateFilter('startDate', e.target.value)}
              aria-label="Start date"
              className="w-[118px] bg-transparent px-1.5 py-1.5 text-xs text-ink focus:outline-none" />
            <span className="material-symbols-outlined text-[14px] text-outline" aria-hidden="true">arrow_forward</span>
            <input type="date" value={filters.endDate} onChange={e => updateFilter('endDate', e.target.value)}
              aria-label="End date"
              className="w-[118px] bg-transparent px-1.5 py-1.5 text-xs text-ink focus:outline-none" />
          </div>
        )}

        {contract.groupBy && (
          <select value={filters.groupBy} onChange={e => updateFilter('groupBy', e.target.value)} className={sel} aria-label="Group report by">
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
        )}

        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
          {contract.advanced && (
            <>
              <select
                value={selectedView}
                onChange={e => {
                  setSelectedView(e.target.value);
                  if (e.target.value) applyView(e.target.value);
                }}
                className="hidden max-w-[150px] rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-semibold text-secondary outline-none hover:border-border focus:ring-2 focus:ring-primary/40 lg:block"
                aria-label="Saved filter view"
              >
                <option value="">Saved views</option>
                {savedViews.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}
              </select>
              <button
                type="button"
                onClick={() => setShowMore(v => !v)}
                aria-expanded={showMore || hasAdvancedFilters}
                aria-controls={advancedId}
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-primary/40 ${
                  showMore || hasAdvancedFilters
                    ? 'border-primary bg-primary-container text-primary'
                    : 'border-border text-secondary hover:bg-surface-container-low'
                }`}
              >
                {showMore ? 'Less filters' : 'More filters'}
                {hasAdvancedFilters && !showMore && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-primary inline-block" />}
              </button>
            </>
          )}
          <button type="button" onClick={resetFilters} className="rounded-lg px-2 py-1.5 text-xs text-outline transition-colors hover:bg-surface-container-low hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40">Reset</button>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={spinning}
            title="Refresh all data"
            aria-label="Refresh all data"
            aria-busy={spinning}
            className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors focus-visible:ring-2 focus-visible:ring-primary/40 ${
              spinning ? 'border-primary bg-primary-container text-primary' : 'border-border text-outline hover:text-primary hover:border-primary'
            }`}
          >
            <span className={`material-symbols-outlined text-[16px] ${spinning ? 'animate-spin' : ''}`} aria-hidden="true">refresh</span>
          </button>
          {lastSynced && (
            <span className="text-[10px] text-outline whitespace-nowrap hidden md:inline">
              {spinning ? 'Syncing…' : fmtTime(lastSynced)}
            </span>
          )}
        </div>
      </div>

      {contract.advanced && (showMore || hasAdvancedFilters) && (
        <div id={advancedId} className="flex flex-wrap items-center gap-2 border-t border-border px-4 pb-2.5 pt-2 sm:px-6">
          <select value={filters.category} onChange={e => updateFilter('category', e.target.value)} className={sel} aria-label="Category filter">
            <option value="">All Categories</option>
            {opts.categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filters.region} onChange={e => updateFilter('region', e.target.value)} className={sel} aria-label="State filter">
            <option value="">All States</option>
            {opts.regions.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={filters.status} onChange={e => updateFilter('status', e.target.value)} className={sel} aria-label="Status filter">
            <option value="">All Statuses</option>
            {opts.statuses.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          {filters.marketplace !== 'meesho' && opts.brands.length > 0 && (
            <select value={filters.brand} onChange={e => updateFilter('brand', e.target.value)} className={sel} aria-label="Brand filter">
              <option value="">All Brands</option>
              {opts.brands.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          )}
          <span className="hidden sm:block h-6 w-px bg-surface-container-high mx-1" />
          <input
            value={viewName}
            onChange={e => setViewName(e.target.value)}
            placeholder="Name this view"
            aria-label="Saved view name"
            className={`${sel} w-36`}
          />
          <button
            type="button"
            onClick={() => {
              const saved = saveView(viewName);
              if (saved) {
                setSelectedView(saved.id);
                setViewName('');
              }
            }}
            disabled={!viewName.trim()}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2"
          >
            Save view
          </button>
          {selectedView && (
            <button
              type="button"
              onClick={() => {
                deleteView(selectedView);
                setSelectedView('');
              }}
              className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 focus-visible:ring-2 focus-visible:ring-rose-400"
            >
              Delete view
            </button>
          )}
        </div>
      )}
    </section>
  );
}
