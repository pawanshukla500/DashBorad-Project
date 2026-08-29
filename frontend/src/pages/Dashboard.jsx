import { useState, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
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
                  <p className="text-[10px] font-semibold text-outline uppercase tracking-wider px-4 pt-3 pb-1.5">Orders ({results.orders.length})</p>
                  {results.orders.map((o, i) => (
                    <div key={i} className="px-4 py-3 hover:bg-surface-container-low transition-colors">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <div className="min-w-0">
                          <span className="font-mono text-[11px] text-primary font-semibold">{o.order_item_id}</span>
                          {o.order_id && o.order_id !== o.order_item_id && (
                            <span className="text-[10px] text-outline ml-1.5">order: {o.order_id}</span>
                          )}
                        </div>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${
                          (o.orders_status || '').toLowerCase().includes('deliver') ? 'bg-emerald-100 text-emerald-700' :
                          (o.orders_status || '').toLowerCase().includes('cancel') ? 'bg-rose-100 text-rose-700' :
                          'bg-surface-container text-secondary'
                        }`}>{o.orders_status || '—'}</span>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-secondary">
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
                  <p className="text-[10px] font-semibold text-outline uppercase tracking-wider px-4 pt-3 pb-1.5">Settlement Rows ({results.settlements.length})</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
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
                            <td className="px-4 py-2 font-mono text-[10px] text-secondary">{s.order_item_id}</td>
                            <td className="px-4 py-2 text-secondary whitespace-nowrap">{s.payment_date || '—'}</td>
                            <td className="px-4 py-2 text-outline font-mono text-[10px] truncate max-w-[80px]">{s.neft_id || '—'}</td>
                            <td className={`px-4 py-2 text-right font-bold ${+s.bank_settlement >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{fmtK(s.bank_settlement)}</td>
                            <td className="px-4 py-2 text-right text-primary font-medium">{+s.protection_fund > 0 ? fmtK(s.protection_fund) : '—'}</td>
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
                  <p className="text-[10px] font-semibold text-outline uppercase tracking-wider px-4 pt-3 pb-1.5">Returns ({results.returns.length})</p>
                  {results.returns.map((r, i) => (
                    <div key={i} className="px-4 py-2.5 hover:bg-surface-container-low flex items-center gap-3">
                      <span className="h-2 w-2 rounded-full bg-rose-400 shrink-0" />
                      <div className="flex-1 min-w-0 text-xs">
                        <span className="font-mono text-[11px] text-secondary">{r.order_item_id}</span>
                        <span className="text-outline ml-2">{r.return_type}</span>
                        {r.return_reason && <span className="text-outline ml-2">· {r.return_reason}</span>}
                      </div>
                      <span className="text-[10px] text-outline shrink-0">{r.return_date?.slice(0, 10) || '—'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* Close strip */}
          <div className="border-t border-border px-4 py-2 flex justify-end">
            <button onClick={() => setOpen(false)} className="text-[11px] text-outline hover:text-secondary">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Marketplace display config — add new marketplaces here
const MP_CONFIG = {
  flipkart: { label: 'Flipkart', bg: 'bg-primary-container', border: 'border-primary', badge: 'bg-primary', text: 'text-primary' },
  amazon:   { label: 'Amazon',   bg: 'bg-amber-50',  border: 'border-amber-200',  badge: 'bg-amber-500',  text: 'text-amber-700'  },
  myntra:   { label: 'Myntra',   bg: 'bg-pink-50',   border: 'border-pink-200',   badge: 'bg-pink-600',   text: 'text-pink-700'   },
  meesho:   { label: 'Meesho',   bg: 'bg-purple-50', border: 'border-purple-200', badge: 'bg-purple-600', text: 'text-purple-700' },
  ajio:     { label: 'Ajio',     bg: 'bg-orange-50', border: 'border-orange-200', badge: 'bg-orange-500', text: 'text-orange-700' },
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

  if (es) return <ErrorBox msg={es} />;

  return (
    <div className="space-y-6 max-w-[1600px]">
      <PageHeader
        title="Dashboard Overview"
        subtitle={
          selectedMP
            ? <>Showing data for <span className="font-semibold text-secondary">{mpLabel}</span></>
            : 'Combined view across all marketplaces'
        }
      >
        <OrderSearch />
      </PageHeader>

      <section className="rounded-2xl border border-border bg-surface-container-low p-4 sm:p-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between mb-4">
          <div>
            <h3 className="font-headline-sm text-headline-sm font-bold text-ink">Daily reconciliation flow</h3>
            <p className="mt-1 font-body-sm text-body-sm text-secondary">Use these three steps in order. Everything else in the sidebar is analysis and detail.</p>
          </div>
          <span className="font-label-sm text-label-sm font-bold uppercase tracking-wider text-primary">Start here</span>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <DashboardAction step="1" title="Upload marketplace files" detail="Sales, returns, and settlement files" to="/upload" tone="indigo" />
          <DashboardAction step="2" title="Fix data and rate gaps" detail="Failed uploads, missing rates, unsettled orders" to="/exceptions" tone="amber" />
          <DashboardAction step="3" title="Review payouts and fee variance" detail="Actual payment, charges, and recovery opportunities" to="/statement" tone="emerald" />
        </div>
      </section>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 xl:grid-cols-5 gap-4">
        {ls ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="bg-surface rounded-2xl border border-border p-6 h-[120px] skeleton-pulse" />
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
          sub={`${num(summary?.customerReturns || 0)} customer · ${num(summary?.courierReturns || 0)} courier`}
          color="rose"
          icon={<ReturnIcon />}
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

function DashboardAction({ step, title, detail, to, tone }) {
  const styles = {
    indigo: 'border-primary hover:border-primary hover:bg-indigo-50',
    amber: 'border-amber-200 hover:border-amber-400 hover:bg-amber-50',
    emerald: 'border-emerald-200 hover:border-emerald-400 hover:bg-emerald-50',
  };
  return (
    <Link to={to} className={`group rounded-xl border bg-surface p-3 transition-colors ${styles[tone]}`}>
      <div className="flex items-start gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-white">{step}</span>
        <div className="min-w-0">
          <p className="text-xs font-bold text-ink group-hover:text-slate-950">{title}</p>
          <p className="mt-1 text-[11px] leading-4 text-secondary">{detail}</p>
        </div>
      </div>
    </Link>
  );
}

function ErrorBox({ msg }) {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-6">
      <p className="text-rose-700 font-semibold mb-1">Failed to load data</p>
      <p className="text-rose-600 text-sm font-mono">{msg}</p>
      <p className="text-rose-500 text-xs mt-2">Make sure the backend is running and the GCP PostgreSQL database is reachable.</p>
    </div>
  );
}

function OrderIcon()      { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>; }
function RevenueIcon()    { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>; }
function ShareIcon()      { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>; }
function ReturnIcon()     { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>; }
function SettlementIcon() { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2z" /></svg>; }
