import { useState, useMemo, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, Legend,
} from 'recharts';
import {
  fetchReturnHeatmap, fetchRtoRisk, fetchFulfilmentPl,
  fetchInsightsMarketplaceSummary,
} from '../api/client';
import { useFilters } from '../context/FilterContext';
import useFetch from '../hooks/useFetch';
import IndiaStateMap from '../components/charts/IndiaStateMap';
import PageHeader from '../components/PageHeader';
import TabGroup from '../components/TabGroup';
import { useAnimatedDisplayValue } from '../hooks/useAnimatedDisplayValue';
import {
  currencyCompact as fmtK,
  formatNumber as fmt,
  percentageOrDash as pct,
} from '../utils/format';

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Marketplace config ────────────────────────────────────────────────────────
const MPs = [
  { id: 'all',       label: 'All',         dot: '#6366f1', pill: 'bg-primary text-white',       soft: 'bg-primary-container text-primary border-primary' },
  { id: 'flipkart',  label: 'Flipkart',    dot: '#f59e0b', pill: 'bg-amber-500 text-white',        soft: 'bg-amber-50 text-amber-700 border-amber-200' },
  { id: 'amazon',    label: 'Amazon',      dot: '#f97316', pill: 'bg-orange-500 text-white',       soft: 'bg-orange-50 text-orange-700 border-orange-200' },
  { id: 'myntra_vb', label: 'Myntra (VB)', dot: '#ec4899', pill: 'bg-pink-500 text-white',         soft: 'bg-pink-50 text-pink-700 border-pink-200' },
  { id: 'myntra_ej', label: 'Myntra (EJ)', dot: '#be185d', pill: 'bg-rose-500 text-white',         soft: 'bg-rose-50 text-rose-700 border-rose-200' },
  { id: 'meesho',    label: 'Meesho',      dot: '#a855f7', pill: 'bg-purple-500 text-white',       soft: 'bg-purple-50 text-purple-700 border-purple-200' },
];
const mpById = Object.fromEntries(MPs.map(m => [m.id, m]));

const MP_COLORS = { flipkart: '#f59e0b', amazon: '#f97316', myntra: '#ec4899', myntra_vb: '#ec4899', myntra_ej: '#be185d', meesho: '#a855f7', all: '#6366f1' };

// ── Risk heat color ───────────────────────────────────────────────────────────
function heatBg(rate) {
  const r = +rate || 0;
  if (r >= 35) return 'bg-red-600 text-white font-bold';
  if (r >= 25) return 'bg-red-400 text-white font-semibold';
  if (r >= 15) return 'bg-orange-400 text-white';
  if (r >= 10) return 'bg-amber-300 text-amber-900';
  if (r >= 5)  return 'bg-yellow-100 text-yellow-800';
  if (r > 0)   return 'bg-emerald-100 text-emerald-700';
  return 'text-outline';
}
function riskBadge(rate) {
  const r = +rate || 0;
  if (r >= 35) return { label: 'Critical', cls: 'bg-red-100 text-red-700 border-red-200' };
  if (r >= 25) return { label: 'High',     cls: 'bg-orange-100 text-orange-700 border-orange-200' };
  if (r >= 15) return { label: 'Medium',   cls: 'bg-amber-100 text-amber-700 border-amber-200' };
  if (r >= 5)  return { label: 'Low',      cls: 'bg-blue-100 text-blue-700 border-blue-200' };
  return { label: 'Minimal', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' };
}

// ── Shared components ─────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, color = 'slate', icon }) {
  const colorMap = {
    slate:   'bg-surface border-border',
    indigo:  'bg-primary-container border-primary',
    rose:    'bg-rose-50 border-rose-200',
    amber:   'bg-amber-50 border-amber-200',
    emerald: 'bg-emerald-50 border-emerald-200',
    violet:  'bg-violet-50 border-violet-200',
    orange:  'bg-orange-50 border-orange-200',
  };
  const valColor = { slate: 'text-ink', indigo: 'text-primary', rose: 'text-rose-600', amber: 'text-amber-700', emerald: 'text-emerald-700', violet: 'text-violet-700', orange: 'text-orange-700' };
  const animatedValue = useAnimatedDisplayValue(value);
  return (
    <div className={`rounded-2xl border px-5 py-4 shadow-sm ${colorMap[color]}`}>
      <div className="flex items-start justify-between mb-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-outline">{label}</p>
        {icon && <span className="text-lg opacity-50">{icon}</span>}
      </div>
      <p className={`text-2xl font-bold leading-tight tabular-nums ${valColor[color]}`}>{animatedValue}</p>
      {sub && <p className="text-xs text-outline mt-0.5">{sub}</p>}
    </div>
  );
}

function SectionCard({ title, sub, children, className = '' }) {
  return (
    <div className={`bg-surface rounded-2xl border border-border shadow-sm p-5 ${className}`}>
      {title && (
        <div className="mb-4">
          <h3 className="text-sm font-bold text-ink">{title}</h3>
          {sub && <p className="text-xs text-outline mt-0.5">{sub}</p>}
        </div>
      )}
      {children}
    </div>
  );
}

function Empty({ msg = 'No data yet' }) {
  return <div className="py-12 text-center text-outline text-sm">{msg}</div>;
}

// ── Marketplace filter bar ────────────────────────────────────────────────────
function MpFilter({ value, onChange }) {
  return (
    <div className="flex items-center gap-1.5 p-1 bg-surface-container rounded-xl">
      {MPs.map(mp => (
        <button
          key={mp.id}
          onClick={() => onChange(mp.id)}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
            value === mp.id ? mp.pill + ' shadow-sm' : 'text-secondary hover:text-ink hover:bg-white'
          }`}
        >
          {mp.label}
        </button>
      ))}
    </div>
  );
}

// ── Tab 1: Return Intelligence ────────────────────────────────────────────────
function ReturnIntelligence({ mp, filters }) {
  const dep = [JSON.stringify(filters), mp];
  const { data, loading } = useFetch(() => fetchReturnHeatmap(filters, mp), dep);

  const byCategory = useMemo(() => {
    if (!data?.byCategory) return [];
    const mp2 = mp === 'all' ? null : mp;
    return (mp2
      ? data.byCategory.filter(r => r.marketplace === mp2)
      : data.byCategory.reduce((acc, r) => {
          const ex = acc.find(a => a.category === r.category);
          if (ex) { ex.orders = +ex.orders + +r.orders; ex.returns = +ex.returns + +r.returns; }
          else acc.push({ ...r, orders: +r.orders, returns: +r.returns });
          return acc;
        }, [])
    ).map(r => ({
      ...r,
      return_rate: +r.orders ? +((+r.returns / +r.orders) * 100).toFixed(1) : 0,
    })).sort((a, b) => b.return_rate - a.return_rate);
  }, [data, mp]);

  const byState = useMemo(() => {
    if (!data?.byState) return [];
    const mp2 = mp === 'all' ? null : mp;
    return (mp2
      ? data.byState.filter(r => r.marketplace === mp2)
      : data.byState.reduce((acc, r) => {
          const ex = acc.find(a => a.state === r.state);
          if (ex) { ex.orders = +ex.orders + +r.orders; ex.returns = +ex.returns + +r.returns; }
          else acc.push({ ...r, orders: +r.orders, returns: +r.returns });
          return acc;
        }, [])
    ).map(r => ({
      ...r,
      return_rate: +r.orders ? +((+r.returns / +r.orders) * 100).toFixed(1) : 0,
    })).sort((a, b) => b.return_rate - a.return_rate).slice(0, 15);
  }, [data, mp]);

  // Category × State matrix (top 8 categories, top 12 states)
  const { cats, states, matrix } = useMemo(() => {
    if (!data?.matrix) return { cats: [], states: [], matrix: {} };
    const mp2 = mp === 'all' ? null : mp;
    const rows = mp2 ? data.matrix.filter(r => r.marketplace === mp2) : data.matrix;
    const catSet  = [...new Set(rows.map(r => r.category))].slice(0, 8);
    const stateSet = [...new Set(rows.map(r => r.state))].slice(0, 12);
    const mat = {};
    for (const r of rows) {
      if (!mat[r.category]) mat[r.category] = {};
      const ex = mat[r.category][r.state];
      if (ex) {
        const o2 = +ex.orders + +r.orders; const re2 = +ex.returns + +r.returns;
        mat[r.category][r.state] = { orders: o2, returns: re2, return_rate: o2 ? +((re2/o2)*100).toFixed(1) : 0 };
      } else {
        mat[r.category][r.state] = { orders: +r.orders, returns: +r.returns, return_rate: +r.return_rate };
      }
    }
    return { cats: catSet, states: stateSet, matrix: mat };
  }, [data, mp]);

  const totalReturns = byCategory.reduce((s, r) => s + +r.returns, 0);
  const totalOrders  = byCategory.reduce((s, r) => s + +r.orders, 0);
  const avgRate      = totalOrders ? +((totalReturns / totalOrders) * 100).toFixed(1) : 0;
  const worstCat     = byCategory[0];
  const worstState   = byState[0];

  const chartData = byCategory.slice(0, 12).map(r => ({ name: r.category, rate: +r.return_rate, returns: +r.returns }));

  if (loading) return <div className="py-16 text-center text-outline text-sm animate-pulse">Loading data…</div>;

  return (
    <div className="space-y-5">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Total Returns"     value={fmt(totalReturns)} sub={`of ${fmt(totalOrders)} orders`} color="rose"    icon="↩️" />
        <KpiCard label="Avg Return Rate"   value={pct(avgRate)}      sub="across all categories"          color="amber"   icon="%" />
        <KpiCard label="Worst Category"    value={worstCat?.category || '—'} sub={worstCat ? `${pct(worstCat.return_rate)} return rate` : '—'} color="orange" icon="⚠️" />
        <KpiCard label="Worst State"       value={worstState?.state || '—'} sub={worstState ? `${pct(worstState.return_rate)} return rate` : '—'} color="violet" icon="📍" />
      </div>

      {/* India Map + Category chart side by side */}
      <div className="grid lg:grid-cols-2 gap-5">
        {/* India State Heatmap */}
        <div className="bg-surface rounded-2xl border border-border shadow-sm p-5">
          <IndiaStateMap
            data={byState}
            title="Return Rate by State — India Map"
            sub="Hover a state to see details · J&K includes Ladakh, POK & Aksai Chin"
          />
        </div>

        <SectionCard title="Return Rate by Category" sub="Sorted by return rate — higher is riskier">
          {chartData.length === 0 ? <Empty /> : (
            <ResponsiveContainer width="100%" height={chartData.length * 38 + 20}>
              <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: '#94a3b8' }} tickFormatter={v => `${v}%`} />
                <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11, fill: '#475569' }} />
                <Tooltip formatter={(v) => [`${v}%`, 'Return Rate']} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="rate" radius={[0, 4, 4, 0]}
                  label={{ position: 'right', fontSize: 10, formatter: v => `${v}%`, fill: '#64748b' }}>
                  {chartData.map((r, i) => (
                    <Cell key={i} fill={+r.rate >= 25 ? '#ef4444' : +r.rate >= 15 ? '#f97316' : +r.rate >= 10 ? '#f59e0b' : '#10b981'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </SectionCard>
      </div>

      {/* State table (compact, below map) */}
      <SectionCard title="Top States by Return Rate" sub="Ranked — tap any row for detail">
        {byState.length === 0 ? <Empty /> : (
          <div className="overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-outline border-b border-border">
                  <th className="text-left py-2 font-medium">#</th>
                  <th className="text-left py-2 font-medium">State</th>
                  <th className="text-right py-2 font-medium">Orders</th>
                  <th className="text-right py-2 font-medium">Returns</th>
                  <th className="text-right py-2 font-medium">Rate</th>
                  <th className="w-24 py-2 font-medium text-right">Bar</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {byState.map((r, i) => (
                  <tr key={i} className="hover:bg-surface-container-low">
                    <td className="py-2 text-outline text-[10px] w-6">{i + 1}</td>
                    <td className="py-2 text-ink font-medium">{r.state}</td>
                    <td className="py-2 text-right text-secondary">{fmt(r.orders)}</td>
                    <td className="py-2 text-right text-secondary">{fmt(r.returns)}</td>
                    <td className="py-2 text-right">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold ${heatBg(r.return_rate)}`}>
                        {pct(r.return_rate)}
                      </span>
                    </td>
                    <td className="py-2 pl-2">
                      <div className="h-2 bg-surface-container rounded-full overflow-hidden w-20">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(+r.return_rate * 2.5, 100)}%`,
                            background: +r.return_rate >= 20 ? '#ef4444' : +r.return_rate >= 10 ? '#f97316' : '#22c55e',
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Category × State heatmap */}
      <SectionCard title="Category × State Heatmap" sub="Return rate at intersection — red = critical, green = healthy">
        {cats.length === 0 ? <Empty /> : (
          <div className="overflow-x-auto">
            <table className="text-[10px] border-collapse w-full">
              <thead>
                <tr>
                  <th className="text-left px-2 py-1.5 text-outline font-medium border border-border bg-surface-container-low min-w-[90px]">Category ↓ / State →</th>
                  {states.map(s => (
                    <th key={s} className="px-2 py-1.5 text-secondary font-medium border border-border bg-surface-container-low whitespace-nowrap">{s}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cats.map(cat => (
                  <tr key={cat}>
                    <td className="px-2 py-1.5 font-medium text-ink border border-border bg-surface-container-low whitespace-nowrap">{cat}</td>
                    {states.map(state => {
                      const cell = matrix[cat]?.[state];
                      return (
                        <td key={state} className={`px-2 py-1.5 text-center border border-border ${cell ? heatBg(cell.return_rate) : 'text-surface'}`}
                          title={cell ? `${cell.returns} returns / ${cell.orders} orders` : 'No data'}>
                          {cell ? `${cell.return_rate}%` : '—'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ── Tab 2: RTO Risk ───────────────────────────────────────────────────────────
function RtoRisk({ mp, filters }) {
  const dep = [JSON.stringify(filters), mp];
  const { data, loading } = useFetch(() => fetchRtoRisk(filters, mp), dep);
  const [search, setSearch] = useState('');

  const skus = useMemo(() => {
    if (!data?.bySku) return [];
    const mp2 = mp === 'all' ? null : mp;
    return (mp2 ? data.bySku.filter(r => r.marketplace === mp2) : data.bySku)
      .filter(r => !search || r.sku?.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => b.return_rate - a.return_rate);
  }, [data, mp, search]);

  const critical = skus.filter(r => +r.return_rate >= 25).length;
  const highRisk  = skus.filter(r => +r.return_rate >= 15).length;
  const totalLost = skus.reduce((s, r) => s + +r.return_value, 0);

  const stateData = useMemo(() => {
    if (!data?.byStateCategory) return [];
    const mp2 = mp === 'all' ? null : mp;
    const rows = mp2 ? data.byStateCategory.filter(r => r.marketplace === mp2) : data.byStateCategory;
    const byState = rows.reduce((acc, r) => {
      const ex = acc.find(a => a.state === r.state);
      if (ex) { ex.orders += +r.orders; ex.returns += +r.returns; }
      else acc.push({ state: r.state, orders: +r.orders, returns: +r.returns });
      return acc;
    }, []).map(r => ({ ...r, return_rate: r.orders ? +((r.returns / r.orders) * 100).toFixed(1) : 0 }));
    return byState.sort((a, b) => b.return_rate - a.return_rate).slice(0, 10);
  }, [data, mp]);

  if (loading) return <div className="py-16 text-center text-outline text-sm animate-pulse">Loading data…</div>;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Critical SKUs"   value={fmt(critical)}  sub="≥ 25% return rate"  color="rose"    icon="🔴" />
        <KpiCard label="High-Risk SKUs"  value={fmt(highRisk)}  sub="≥ 15% return rate"  color="orange"  icon="🟠" />
        <KpiCard label="Revenue at Risk" value={fmtK(totalLost)} sub="value returned"    color="amber"   icon="₹" />
        <KpiCard label="SKUs Tracked"    value={fmt(skus.length)} sub="with ≥ 3 orders"  color="slate"   icon="📋" />
      </div>

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <SectionCard title="SKU Risk Table" sub="Ranked by return rate — only SKUs with 3+ orders shown">
            <div className="mb-3">
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search SKU…"
                className="w-full border border-border rounded-lg px-3 py-1.5 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            {skus.length === 0 ? <Empty /> : (
              <div className="overflow-auto max-h-80">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-surface z-10">
                    <tr className="text-outline border-b border-border">
                      <th className="text-left py-2 font-medium">SKU</th>
                      <th className="text-left py-2 font-medium">Category</th>
                      <th className="text-right py-2 font-medium">Orders</th>
                      <th className="text-right py-2 font-medium">Returns</th>
                      <th className="text-right py-2 font-medium">Rate</th>
                      <th className="text-right py-2 font-medium">Lost ₹</th>
                      <th className="text-center py-2 font-medium">Risk</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {skus.map((r, i) => {
                      const rb = riskBadge(r.return_rate);
                      return (
                        <tr key={i} className="hover:bg-surface-container-low">
                          <td className="py-2 font-mono text-[10px] text-secondary max-w-[120px] truncate">{r.sku}</td>
                          <td className="py-2 text-secondary">{r.category}</td>
                          <td className="py-2 text-right text-secondary">{fmt(r.orders)}</td>
                          <td className="py-2 text-right text-rose-600 font-medium">{fmt(r.returns)}</td>
                          <td className="py-2 text-right">
                            <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${heatBg(r.return_rate)}`}>{pct(r.return_rate)}</span>
                          </td>
                          <td className="py-2 text-right text-secondary">{fmtK(r.return_value)}</td>
                          <td className="py-2 text-center">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-semibold border ${rb.cls}`}>{rb.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </div>

        <SectionCard title="Top Risk States" sub="States with highest return rates">
          {stateData.length === 0 ? <Empty /> : (
            <div className="space-y-2">
              {stateData.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs text-secondary w-4 text-right shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-xs font-medium text-ink truncate">{r.state}</span>
                      <span className={`text-[10px] font-bold ml-2 shrink-0 ${+r.return_rate >= 25 ? 'text-red-600' : +r.return_rate >= 15 ? 'text-orange-500' : 'text-amber-600'}`}>{pct(r.return_rate)}</span>
                    </div>
                    <div className="h-1.5 bg-surface-container rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${+r.return_rate >= 25 ? 'bg-red-500' : +r.return_rate >= 15 ? 'bg-orange-400' : 'bg-amber-400'}`}
                        style={{ width: `${Math.min(+r.return_rate * 2, 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

// ── Tab 3: Fulfilment P&L ─────────────────────────────────────────────────────
function FulfilmentPL({ mp, filters }) {
  const dep = [JSON.stringify(filters), mp];
  const { data, loading } = useFetch(() => fetchFulfilmentPl(filters, mp), dep);

  const ftData = useMemo(() => {
    if (!data?.byFulfilment) return [];
    const mp2 = mp === 'all' ? null : mp;
    const rows = mp2 ? data.byFulfilment.filter(r => r.marketplace === mp2) : data.byFulfilment.reduce((acc, r) => {
      const ex = acc.find(a => a.ft === r.ft);
      if (ex) {
        ex.orders = +ex.orders + +r.orders;
        ex.revenue = +ex.revenue + +r.revenue;
        ex.total_fees = +ex.total_fees + +r.total_fees;
        ex.settlement = +ex.settlement + +r.settlement;
        ex.returns = +ex.returns + +r.returns;
      } else {
        acc.push({ ...r, orders: +r.orders, revenue: +r.revenue, total_fees: +r.total_fees, settlement: +r.settlement, returns: +r.returns });
      }
      return acc;
    }, []);
    return rows.map(r => ({
      ...r,
      fee_rate: +r.revenue ? +((+r.total_fees / +r.revenue) * 100).toFixed(1) : 0,
      net: +r.revenue - +r.total_fees,
      margin: +r.revenue ? +((1 - +r.total_fees / +r.revenue) * 100).toFixed(1) : 0,
      return_rate: +r.orders ? +((+r.returns / +r.orders) * 100).toFixed(1) : 0,
    })).sort((a, b) => b.revenue - a.revenue);
  }, [data, mp]);

  const catData = useMemo(() => {
    if (!data?.byCategoryFt) return [];
    const mp2 = mp === 'all' ? null : mp;
    return mp2 ? data.byCategoryFt.filter(r => r.marketplace === mp2) : data.byCategoryFt;
  }, [data, mp]);

  const chartData = ftData.map(r => ({
    name: r.ft, revenue: +r.revenue, fees: +r.total_fees, net: +r.net,
  }));

  const FT_COLORS = { FBF: '#6366f1', FBA: '#f97316', Flex: '#10b981', 'Easy Ship': '#06b6d4', 'Self-Ship': '#8b5cf6', Unknown: '#94a3b8' };

  if (loading) return <div className="py-16 text-center text-outline text-sm animate-pulse">Loading data…</div>;

  return (
    <div className="space-y-5">
      {/* Fulfilment type cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {ftData.slice(0, 4).map(r => (
          <div key={r.ft} className="bg-surface rounded-2xl border border-border shadow-sm p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="h-3 w-3 rounded-full shrink-0" style={{ background: FT_COLORS[r.ft] || '#94a3b8' }} />
              <span className="text-xs font-bold text-ink">{r.ft}</span>
              {mp === 'all' && <span className="ml-auto text-[9px] text-outline">{r.marketplace}</span>}
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs"><span className="text-outline">Revenue</span><span className="font-semibold text-ink">{fmtK(r.revenue)}</span></div>
              <div className="flex justify-between text-xs"><span className="text-outline">Total Fees</span><span className="font-semibold text-orange-600">{fmtK(r.total_fees)}</span></div>
              <div className="flex justify-between text-xs"><span className="text-outline">Net to You</span><span className="font-bold text-emerald-700">{fmtK(r.net)}</span></div>
              <div className="flex justify-between text-xs"><span className="text-outline">Fee %</span><span className={`font-semibold ${r.fee_rate > 30 ? 'text-red-600' : r.fee_rate > 20 ? 'text-amber-600' : 'text-emerald-600'}`}>{pct(r.fee_rate)}</span></div>
              <div className="flex justify-between text-xs"><span className="text-outline">Return Rate</span><span className={`font-semibold ${+r.return_rate > 20 ? 'text-red-600' : 'text-secondary'}`}>{pct(r.return_rate)}</span></div>
              <div className="mt-2 pt-2 border-t border-border flex justify-between text-xs">
                <span className="text-outline">Orders</span>
                <span className="font-medium text-secondary">{fmt(r.orders)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Chart */}
      <SectionCard title="Revenue vs Fees by Fulfilment Type" sub="Compare earnings efficiency across channels">
        {chartData.length === 0 ? <Empty /> : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData} barGap={4}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} />
              <YAxis tickFormatter={v => `₹${(v/1000).toFixed(0)}K`} tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <Tooltip formatter={(v, n) => [fmtK(v), n.charAt(0).toUpperCase() + n.slice(1)]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="revenue" name="Revenue" fill="#6366f1" radius={[4, 4, 0, 0]} />
              <Bar dataKey="fees"    name="Fees"    fill="#f97316" radius={[4, 4, 0, 0]} />
              <Bar dataKey="net"     name="Net"     fill="#10b981" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </SectionCard>

      {/* Category × Fulfilment table */}
      <SectionCard title="Category × Fulfilment Breakdown" sub="Revenue per category per fulfilment channel">
        {catData.length === 0 ? <Empty /> : (
          <div className="overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-outline border-b border-border">
                  <th className="text-left py-2 font-medium">Category</th>
                  <th className="text-left py-2 font-medium">Fulfilment</th>
                  {mp === 'all' && <th className="text-left py-2 font-medium">Platform</th>}
                  <th className="text-right py-2 font-medium">Orders</th>
                  <th className="text-right py-2 font-medium">Revenue</th>
                  <th className="text-right py-2 font-medium">Settlement</th>
                  <th className="text-right py-2 font-medium">Returns</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {catData.slice(0, 30).map((r, i) => (
                  <tr key={i} className="hover:bg-surface-container-low">
                    <td className="py-2 font-medium text-ink">{r.category}</td>
                    <td className="py-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: FT_COLORS[r.ft] || '#94a3b8' }} />
                        <span className="text-secondary">{r.ft}</span>
                      </span>
                    </td>
                    {mp === 'all' && <td className="py-2 text-outline">{r.marketplace}</td>}
                    <td className="py-2 text-right text-secondary">{fmt(r.orders)}</td>
                    <td className="py-2 text-right text-ink font-medium">{fmtK(r.revenue)}</td>
                    <td className="py-2 text-right text-emerald-600">{fmtK(r.settlement)}</td>
                    <td className="py-2 text-right text-rose-500">{fmt(r.returns)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ── Marketplace Overview ───────────────────────────────────────────────────────
function MarketplaceOverview({ filters }) {
  const dep = [JSON.stringify(filters)];
  const { data } = useFetch(() => fetchInsightsMarketplaceSummary(filters), dep);
  const rows = data?.marketplaces || [];
  if (rows.length === 0) return null;

  const MP_PALETTE = { flipkart: '#f59e0b', amazon: '#f97316', myntra: '#ec4899', myntra_vb: '#ec4899', myntra_ej: '#be185d', meesho: '#a855f7' };

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
      {rows.map(r => {
        const color = MP_PALETTE[r.marketplace] || '#6366f1';
        const feeRate = +r.revenue ? +((+r.total_fees / +r.revenue) * 100).toFixed(1) : 0;
        return (
          <div key={r.marketplace} className="bg-surface rounded-2xl border border-border shadow-sm overflow-hidden">
            <div className="h-1" style={{ background: color }} />
            <div className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: color }} />
                <span className="text-sm font-bold text-ink capitalize">{r.marketplace}</span>
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs"><span className="text-outline">Revenue</span><span className="font-bold text-ink">{fmtK(r.revenue)}</span></div>
                <div className="flex justify-between text-xs"><span className="text-outline">Orders</span><span className="font-medium text-secondary">{fmt(r.orders)}</span></div>
                <div className="flex justify-between text-xs"><span className="text-outline">Return Rate</span><span className={`font-semibold ${+r.return_rate > 20 ? 'text-red-600' : 'text-secondary'}`}>{pct(r.return_rate)}</span></div>
                <div className="flex justify-between text-xs"><span className="text-outline">Fee %</span><span className={`font-semibold ${feeRate > 30 ? 'text-orange-600' : 'text-secondary'}`}>{pct(feeRate)}</span></div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'return',     label: 'Return Intelligence', icon: '↩' },
  { id: 'rto',        label: 'RTO Risk',            icon: '⚠' },
  { id: 'fulfilment', label: 'Fulfilment P&L',      icon: '◫' },
];

export default function InsightsPage() {
  const { filters, refreshKey } = useFilters();
  const reportFilters = { ...filters, _refresh: refreshKey || undefined };
  const mp = filters.marketplace || 'all';
  const [tab, setTab] = useState('return');

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <PageHeader
        title="Seller Intelligence"
        subtitle="Deep analytics · returns · RTO risk · fulfilment P&L — uses FilterBar marketplace & dates"
      >
        <Link
          to="/calculator"
          className="text-xs font-semibold text-[#902A4A] border border-[#902A4A]/25 px-3 py-1.5 rounded-lg hover:bg-[#902A4A]/[0.06]"
        >
          Fee Calculator →
        </Link>
      </PageHeader>

      {/* Marketplace overview cards */}
      <MarketplaceOverview filters={reportFilters} key={refreshKey} />

      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <TabGroup tabs={TABS} value={tab} onChange={setTab} />
      </div>

      {/* Tab content */}
      <div>
        {tab === 'return'     && <ReturnIntelligence mp={mp} filters={reportFilters} />}
        {tab === 'rto'        && <RtoRisk            mp={mp} filters={reportFilters} />}
        {tab === 'fulfilment' && <FulfilmentPL       mp={mp} filters={reportFilters} />}
      </div>
    </div>
  );
}
