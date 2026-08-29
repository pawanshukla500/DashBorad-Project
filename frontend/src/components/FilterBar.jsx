import { useEffect, useState, useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useFilters } from '../context/FilterContext';
import { fetchFilters } from '../api/client';
import { filtersForPath } from '../navigation';

const MARKETPLACES = [
  { id: '',         label: 'All' },
  { id: 'flipkart', label: 'Flipkart' },
  { id: 'amazon',   label: 'Amazon' },
  { id: 'myntra',   label: 'Myntra' },
  { id: 'meesho',   label: 'Meesho' },
  { id: 'ajio',     label: 'Ajio' },
];

const MP_ACTIVE = {
  '':         'bg-ink text-surface border-ink shadow-sm',
  flipkart:   'bg-[#0456C8] text-white border-[#0456C8] shadow-sm',
  amazon:     'bg-[#FF9900] text-black border-[#FF9900] shadow-sm',
  myntra:     'bg-[#F13AB1] text-white border-[#F13AB1] shadow-sm',
  meesho:     'bg-[#F43397] text-white border-[#F43397] shadow-sm',
  ajio:       'bg-[#2C4152] text-white border-[#2C4152] shadow-sm',
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

  if (!filtersShown) {
    return (
      <div className="bg-surface/95 border-b border-border px-4 sm:px-6 py-2 font-body-sm text-body-sm text-outline">
        Global date filters do not apply on this page — use the controls in the workspace below.
      </div>
    );
  }

  const sel = 'font-body-sm text-body-sm border border-border rounded-lg px-2.5 py-1.5 text-ink bg-surface focus:outline-none focus:ring-2 focus:ring-primary/40 hover:border-outline transition-colors min-w-0';

  return (
    <div className="bg-surface/95 backdrop-blur-sm border-b border-border sticky top-16 z-20">
      <div className="px-4 sm:px-6 py-2.5 flex items-center gap-2 flex-wrap">
        {contract.marketplace && (
          <div className="flex items-center gap-1 flex-wrap">
            {MARKETPLACES.map(mp => {
              const isActive = filters.marketplace === mp.id;
              return (
                <button
                  key={mp.id}
                  onClick={() => { updateFilter('marketplace', mp.id); if (mp.id === 'meesho') updateFilter('brand', ''); }}
                  className={`px-3 py-1 rounded-full font-label-md text-label-md uppercase border transition-all ${
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
          <div className="flex items-center bg-surface border border-border rounded-lg overflow-hidden hover:border-border transition-colors focus-within:ring-2 focus-within:ring-primary/50">
            <div className="pl-2.5 pr-1.5 py-1 bg-surface-container-low border-r border-border">
              <svg className="w-3.5 h-3.5 text-outline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <input type="date" value={filters.startDate} onChange={e => updateFilter('startDate', e.target.value)}
              className="text-xs px-1.5 py-1.5 text-ink bg-transparent focus:outline-none w-[118px]" />
            <span className="text-outline text-xs">→</span>
            <input type="date" value={filters.endDate} onChange={e => updateFilter('endDate', e.target.value)}
              className="text-xs px-1.5 py-1.5 text-ink bg-transparent focus:outline-none w-[118px]" />
          </div>
        )}

        {contract.groupBy && (
          <select value={filters.groupBy} onChange={e => updateFilter('groupBy', e.target.value)} className={sel}>
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
        )}

        <div className="flex items-center gap-1.5 ml-auto">
          {contract.advanced && (
            <>
              <select
                value={selectedView}
                onChange={e => {
                  setSelectedView(e.target.value);
                  if (e.target.value) applyView(e.target.value);
                }}
                className="hidden lg:block max-w-[150px] rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-semibold text-secondary outline-none hover:border-border"
                aria-label="Saved filter view"
              >
                <option value="">Saved views</option>
                {savedViews.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}
              </select>
              <button
                type="button"
                onClick={() => setShowMore(v => !v)}
                className={`text-xs font-semibold px-2.5 py-1.5 rounded-lg border transition-colors ${
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
          <button onClick={resetFilters} className="text-xs text-outline hover:text-ink px-2 py-1.5">Reset</button>
          <button
            onClick={handleRefresh}
            disabled={spinning}
            title="Refresh all data"
            className={`flex items-center justify-center w-8 h-8 rounded-lg border transition-colors ${
              spinning ? 'border-primary bg-primary-container text-primary' : 'border-border text-outline hover:text-primary hover:border-primary'
            }`}
          >
            <svg className={`w-3.5 h-3.5 ${spinning ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          {lastSynced && (
            <span className="text-[10px] text-outline whitespace-nowrap hidden md:inline">
              {spinning ? 'Syncing…' : fmtTime(lastSynced)}
            </span>
          )}
        </div>
      </div>

      {contract.advanced && (showMore || hasAdvancedFilters) && (
        <div className="px-4 sm:px-6 pb-2.5 flex items-center gap-2 flex-wrap border-t border-border pt-2">
          <select value={filters.category} onChange={e => updateFilter('category', e.target.value)} className={sel}>
            <option value="">All Categories</option>
            {opts.categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filters.region} onChange={e => updateFilter('region', e.target.value)} className={sel}>
            <option value="">All States</option>
            {opts.regions.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={filters.status} onChange={e => updateFilter('status', e.target.value)} className={sel}>
            <option value="">All Statuses</option>
            {opts.statuses.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          {filters.marketplace !== 'meesho' && opts.brands.length > 0 && (
            <select value={filters.brand} onChange={e => updateFilter('brand', e.target.value)} className={sel}>
              <option value="">All Brands</option>
              {opts.brands.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          )}
          <span className="hidden sm:block h-6 w-px bg-surface-container-high mx-1" />
          <input
            value={viewName}
            onChange={e => setViewName(e.target.value)}
            placeholder="Name this view"
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
            className="rounded-lg bg-[#902A4A] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40"
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
              className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50"
            >
              Delete view
            </button>
          )}
        </div>
      )}
    </div>
  );
}
