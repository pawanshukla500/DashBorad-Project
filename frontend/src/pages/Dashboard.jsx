import { useState, useRef, useCallback } from 'react';
import { useFilters } from '../context/FilterContext';
import useFetch from '../hooks/useFetch';
import {
  fetchSummary, fetchSalesTrend,
  fetchReturnReasons, fetchCategoryBreakdown, fetchTopProducts,
  searchOrder,
} from '../api/client';
import KPICard from '../components/KPICard';
import PageHeader from '../components/PageHeader';
import SalesTrendChart from '../components/charts/SalesTrendChart';
import ReturnReasonsChart from '../components/charts/ReturnReasonsChart';
import CategoryChart from '../components/charts/CategoryChart';
import TopProductsChart from '../components/charts/TopProductsChart';
import { currency, pct, num } from '../utils/format';

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtK = (v) => { const n = +v; if (!n) return '₹0'; if (Math.abs(n) >= 100000) return `₹${(n/100000).toFixed(1)}L`; if (Math.abs(n) >= 1000) return `₹${(n/1000).toFixed(1)}K`; return `₹${n}`; };

// ── Order Search ──────────────────────────────────────────────────────────────
function OrderSearch() {
  const [query, setQuery]     = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen]       = useState(false);
  const debounce              = useRef(null);

  const runSearch = useCallback(async (q) => {
    if (q.length < 3) { setResults(null); setOpen(false); return; }
    setLoading(true);
    try {
      const data = await searchOrder(q);
      setResults(data);
      setOpen(true);
    } catch { setResults(null); }
    setLoading(false);
  }, []);

  function handleChange(e) {
    const q = e.target.value;
    setQuery(q);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => runSearch(q.trim()), 420);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') { clearTimeout(debounce.current); runSearch(query.trim()); }
    if (e.key === 'Escape') { setOpen(false); }
  }

  const hasResults = results && (results.orders?.length || results.settlements?.length || results.returns?.length);

  return (
    <div className="relative w-full max-w-sm">
      {/* Input */}
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-outline">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" /></svg>
        </span>
        {loading && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2">
            <svg className="w-3.5 h-3.5 animate-spin text-primary" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>
          </span>
        )}
        <input
          type="text"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => hasResults && setOpen(true)}
          placeholder="Search order ID or item ID…"
          className="w-full pl-9 pr-9 py-2 text-sm rounded-xl border border-border bg-surface shadow-sm focus:outline-none focus:ring-2 focus:ring-primary placeholder-slate-300"
        />
      </div>

      {/* Results dropdown */}
      {open && (
        <div className="absolute z-[100] top-full mt-2 left-0 right-0 bg-surface rounded-2xl shadow-2xl border border-border overflow-hidden max-h-[500px] overflow-y-auto">
          {!hasResults ? (
            <p className="text-xs text-outline text-center py-6">No results for "{query}"</p>
          ) : (
            <div className="divide-y divide-slate-50">

              {/* Orders section */}
              {results.orders?.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-outline uppercase tracking-wider px-4 pt-3 pb-1.5">Orders ({results.orders.length})</p>
                  {results.orders.map((o, i) => (
                    <div key={i} className="px-4 py-3 hover:bg-surface-container-low transition-colors">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <div className="min-w-0">
                          <span className="font-mono text-[12px] text-primary font-medium">{o.order_item_id}</span>
                          {o.order_id && o.order_id !== o.order_item_id && (
                            <span className="text-xs text-outline ml-1.5">order: {o.order_id}</span>
                          )}
                        </div>
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full shrink-0 ${
                          (o.orders_status || '').toLowerCase().includes('deliver') ? 'bg-emerald-100 text-emerald-700' :
                          (o.orders_status || '').toLowerCase().includes('cancel') ? 'bg-rose-100 text-rose-700' :
                          'bg-surface-container text-secondary'
                        }`}>{o.orders_status || '—'}</span>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-secondary">
                        <span>{o.sku || '—'}</span>
                        <span className="text-outline">·</span>
                        <span>{o.category || '—'}</span>
                        <span className="text-outline">·</span>
                        <span className="capitalize">{o.marketplace}</span>
                        <span className="text-outline">·</span>
                        <span>{o.order_date?.slice(0, 10) || '—'}</span>
                        <span className="text-outline">·</span>
                        <span className="font-semibold text-ink">{fmtK(o.final_invoice_amount)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Settlement rows */}
              {results.settlements?.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-outline uppercase tracking-wider px-4 pt-3 pb-1.5">Settlement Rows ({results.settlements.length})</p>
                  <div className="overflow-x-auto">
                    <table className="finance-table">
                      <thead>
                        <tr className="text-outline border-b border-border">
                          <th className="text-left px-4 py-2 font-medium">Order Item ID</th>
                          <th className="text-left px-4 py-2 font-medium">Date</th>
                          <th className="text-left px-4 py-2 font-medium">NEFT</th>
                          <th className="text-right px-4 py-2 font-medium">Bank Settle</th>
                          <th className="text-right px-4 py-2 font-medium">SPF</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {results.settlements.map((s, i) => (
                          <tr key={i} className="hover:bg-surface-container-low">
                            <td className="cell-id">{s.order_item_id}</td>
                            <td className="text-secondary whitespace-nowrap">{s.payment_date || '—'}</td>
                            <td className="cell-id truncate max-w-[80px]">{s.neft_id || '—'}</td>
                            <td className={`cell-amount font-semibold ${+s.bank_settlement >= 0 ? 'text-success' : 'text-danger'}`}>{fmtK(s.bank_settlement)}</td>
                            <td className="cell-amount text-primary">{+s.protection_fund > 0 ? fmtK(s.protection_fund) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Returns section */}
              {results.returns?.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-outline uppercase tracking-wider px-4 pt-3 pb-1.5">Returns ({results.returns.length})</p>
                  {results.returns.map((r, i) => (
                    <div key={i} className="px-4 py-2.5 hover:bg-surface-container-low flex items-center gap-3">
                      <span className="h-2 w-2 rounded-full bg-rose-400 shrink-0" />
                      <div className="flex-1 min-w-0 text-xs">
                        <span className="font-mono text-[12px] font-medium text-secondary">{r.order_item_id}</span>
                        <span className="text-outline ml-2">{r.return_type}</span>
                        {r.return_reason && <span className="text-outline ml-2">· {r.return_reason}</span>}
                      </div>
                      <span className="text-xs text-outline shrink-0">{r.return_date?.slice(0, 10) || '—'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* Close strip */}
          <div className="border-t border-border px-4 py-2 flex justify-end">
            <button onClick={() => setOpen(false)} className="text-xs text-outline hover:text-secondary">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Marketplace display config — add new marketplaces here
const MP_CONFIG = {
  flipkart:  { label: 'Flipkart',    bg: 'bg-primary-container', border: 'border-primary', badge: 'bg-primary', text: 'text-primary' },
  amazon:    { label: 'Amazon',      bg: 'bg-amber-50',  border: 'border-amber-200',  badge: 'bg-amber-500',  text: 'text-amber-700'  },
  myntra:    { label: 'Myntra',      bg: 'bg-pink-50',   border: 'border-pink-200',   badge: 'bg-pink-600',   text: 'text-pink-700'   },
  myntra_vb: { label: 'Myntra (VB)', bg: 'bg-pink-50',   border: 'border-pink-200',   badge: 'bg-pink-600',   text: 'text-pink-700'   },
  myntra_ej: { label: 'Myntra (EJ)', bg: 'bg-rose-50',   border: 'border-rose-200',   badge: 'bg-rose-600',   text: 'text-rose-700'   },
  meesho:    { label: 'Meesho',      bg: 'bg-purple-50', border: 'border-purple-200', badge: 'bg-purple-600', text: 'text-purple-700' },
  ajio:      { label: 'Ajio',        bg: 'bg-orange-50', border: 'border-orange-200', badge: 'bg-orange-500', text: 'text-orange-700' },
};
function mpCfg(id) {
  return MP_CONFIG[(id || '').toLowerCase()] || { label: id, bg: 'bg-surface-container-low', border: 'border-border', badge: 'bg-secondary', text: 'text-ink' };
}

export default function Dashboard() {
  const { filters, refreshKey } = useFilters();
  const dep = [JSON.stringify(filters), refreshKey];
  const reportFilters = { ...filters, _refresh: refreshKey || undefined };

  const { data: summary,    loading: ls,  error: es  } = useFetch(() => fetchSummary(reportFilters), dep);
  const { data: trend                                 } = useFetch(() => fetchSalesTrend(reportFilters), dep);
  const { data: reasons                               } = useFetch(() => fetchReturnReasons(reportFilters), dep);
  const { data: cats                                  } = useFetch(() => fetchCategoryBreakdown(reportFilters), dep);
  const { data: products                              } = useFetch(() => fetchTopProducts(reportFilters, 8), dep);

  const selectedMP = filters.marketplace;
  const mpLabel    = selectedMP ? (mpCfg(selectedMP).label) : 'All Marketplaces';
  const resolvedReturns = (+summary?.goodReturns || 0) + (+summary?.badReturns || 0);
  const recoveryRate = resolvedReturns > 0
    ? ((+summary.goodReturns || 0) / resolvedReturns) * 100
    : 0;

  if (es) return <ErrorBox msg={es} />;

  return (
    <div className="space-y-6 max-w-[1600px]">
      <PageHeader
        subtitle={
          selectedMP
            ? <>Showing data for <span className="font-medium text-secondary">{mpLabel}</span></>
            : 'Combined view across all marketplaces'
        }
      >
        <OrderSearch />
      </PageHeader>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 xl:grid-cols-6 gap-4">
        {ls ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-surface rounded-xl border border-border p-4 h-[112px] skeleton-pulse" />
          ))
        ) : (
          <>
        <KPICard
          title="Total Orders"
          value={num(summary?.totalOrders)}
          sub={`${num(summary?.returnCount || 0)} returned`}
          color="indigo"
          icon={<OrderIcon />}
        />
        <KPICard
          title="Gross Revenue"
          value={currency(summary?.totalRevenue)}
          sub="Customer invoice total"
          color="sky"
          icon={<RevenueIcon />}
        />
        <KPICard
          title="Bank Received"
          value={currency(summary?.bankReceived ?? summary?.myShare)}
          sub="Net settlement credited to bank"
          color="emerald"
          icon={<ShareIcon />}
        />
        <KPICard
          title="Return Rate"
          value={pct(summary?.returnRate)}
          sub={
            <>
              <span>{num(summary?.customerReturns || 0)} customer · {num(summary?.courierReturns || 0)} courier</span>
              <span className="block text-xs text-gray-400">{currency(summary?.totalRefunds)} refunded</span>
            </>
          }
          color="rose"
          icon={<ReturnIcon />}
        />
        <KPICard
          title="Recovery Rate"
          value={`${recoveryRate.toFixed(1)}%`}
          sub={`${num(summary?.goodReturns || 0)} good · ${num(summary?.badReturns || 0)} bad`}
          color={recoveryRate > 70 ? 'emerald' : recoveryRate >= 50 ? 'amber' : 'rose'}
          icon={<TrendingUpIcon />}
        />
        <KPICard
          title="Fees Paid"
          value={currency(summary?.totalFees)}
          sub={`${num(summary?.unsettledCount || 0)} orders unsettled`}
          color="amber"
          icon={<SettlementIcon />}
        />
          </>
        )}
      </div>

      {/* Trend + Reasons */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2">
          <SalesTrendChart data={trend || []} />
        </div>
        <ReturnReasonsChart data={reasons || []} />
      </div>

      {/* Category + Top Products */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2">
          <CategoryChart data={cats || []} />
        </div>
        <TopProductsChart data={products || []} />
      </div>
    </div>
  );
}


function ErrorBox({ msg }) {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-6">
      <p className="text-rose-700 font-semibold mb-1">Failed to load data</p>
      <p className="text-rose-600 text-sm font-mono">{msg}</p>
      <p className="text-rose-500 text-xs mt-2">Make sure the backend is running and the Hostinger PostgreSQL database is reachable.</p>
    </div>
  );
}

function OrderIcon()      { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>; }
function RevenueIcon()    { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>; }
function ShareIcon()      { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>; }
function ReturnIcon()     { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>; }
function TrendingUpIcon()  { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 17l6-6 4 4 8-8M15 7h6v6" /></svg>; }
function SettlementIcon() { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2z" /></svg>; }
