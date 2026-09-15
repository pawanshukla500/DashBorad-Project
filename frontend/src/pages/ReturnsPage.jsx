import { useState, useMemo, useEffect, useCallback } from 'react';
import { useFilters } from '../context/FilterContext';
import useFetch from '../hooks/useFetch';
import {
  fetchSummary, fetchReturnTrend, fetchReturnReasons, fetchReturnTypes,
  fetchReturns, fetchAllReturns, fetchSkuReturnSummary, fetchSkuOrders,
} from '../api/client';
import ExportButton from '../components/ExportButton';
import PageHeader from '../components/PageHeader';
import TabGroup from '../components/TabGroup';
import { buildReturnsExport } from '../utils/exportXlsx';
import KPICard from '../components/KPICard';
import ReturnReasonsChart from '../components/charts/ReturnReasonsChart';
import ReturnTrendChart from '../components/charts/ReturnTrendChart';
import OrderDetailDrawer, { OrderIdCell } from '../components/OrderDetailDrawer';
import { currency, pct, num } from '../utils/format';

const TYPE_COLORS = {
  customer_return: '#f59e0b',
  CUSTOMER_RETURN: '#f59e0b',
  Return: '#f59e0b',
  courier_return: '#8b5cf6',
  RTO: '#8b5cf6',
};

export default function ReturnsPage() {
  const { filters, refreshKey } = useFilters();
  const dep = [JSON.stringify(filters), refreshKey];
  const reportFilters = { ...filters, _refresh: refreshKey || undefined };
  const [tab, setTab] = useState('analytics');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState(null);

  const { data: summary } = useFetch(() => fetchSummary(reportFilters), dep);
  const { data: trend }   = useFetch(() => fetchReturnTrend(reportFilters), dep);
  const { data: reasons } = useFetch(() => fetchReturnReasons(reportFilters), dep);
  const { data: types }   = useFetch(() => fetchReturnTypes(reportFilters), dep);
  const { data: returns, loading: lr } = useFetch(() => fetchReturns(reportFilters, page), [...dep, page]);

  return (
    <>
    <div className="space-y-6 max-w-[1600px]">
      <PageHeader title="Return Analysis" subtitle="Order returns · cross-referenced by order_item_id">
        <TabGroup
          tabs={[
            { id: 'analytics', label: 'Analytics' },
            { id: 'sku', label: 'SKU Summary' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </PageHeader>

      {/* ── KPIs (always visible) ────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 xl:grid-cols-6 gap-4">
        <KPICard title="Total Returns"    value={num(summary?.returnCount)}      sub={`of ${num(summary?.totalOrders)} orders`}  color="rose"   icon={<ReturnIcon />} />
        <KPICard title="Return Rate"      value={pct(summary?.returnRate)}        sub="Orders with a return"                       color="amber"  icon={<RateIcon />} />
        <KPICard title="Customer Returns" value={num(summary?.customerReturns)}   sub="customer_return type"                       color="orange" icon={<CustomerIcon />} />
        <KPICard title="Courier Returns"  value={num(summary?.courierReturns)}    sub="courier_return / RTO"                       color="indigo" icon={<CourierIcon />} />
        <KPICard title="Good Returns"    value={num(summary?.goodReturns)}      sub={`${num(summary?.pendingCondition)} pending QC`}          color="emerald" icon={<GoodIcon />} />
        <KPICard title="Bad Returns"     value={num(summary?.badReturns)}       sub="QC damaged / rejected"                              color="violet"  icon={<BadIcon />} />
      </div>

      {/* ── Analytics tab ────────────────────────────────────────────────────── */}
      {tab === 'analytics' && (
        <>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="xl:col-span-2">
              <ReturnTrendChart data={trend || []} />
            </div>
            <div className="bg-surface rounded-xl border border-border/80 p-5 shadow-sm">
              <h3 className="font-display text-headline-sm font-semibold text-ink mb-0.5">Return Types</h3>
              <p className="text-xs text-outline mb-5">How returns were initiated</p>
              {(types || []).length === 0 ? (
                <div className="h-48 flex items-center justify-center text-outline text-sm">No data</div>
              ) : (
                <div className="space-y-4">
                  {(types || []).map((t) => {
                    const total = (types || []).reduce((s, x) => s + (+x.count || 0), 0);
                    const count = +t.count || 0;
                    const share = total > 0 ? (count / total) * 100 : 0;
                    const color = TYPE_COLORS[t.type] || '#6366f1';
                    const label = (t.type || 'Unknown').replace(/_/g, ' ');
                    return (
                      <div key={t.type}>
                        <div className="flex items-center justify-between gap-3 mb-1.5">
                          <span className="text-sm font-medium text-ink capitalize">{label}</span>
                          <span className="text-sm font-bold text-ink tabular-nums">
                            {num(count)} <span className="font-medium text-outline">({share.toFixed(1)}%)</span>
                          </span>
                        </div>
                        <div className="h-2.5 bg-surface-container rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-700 ease-out"
                            style={{ width: `${Math.max(share, 2)}%`, background: color }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <ReturnReasonsChart data={reasons || []} />

          {/* Returns Detail Table */}
          <div className="bg-surface rounded-xl border border-border overflow-hidden shadow-sm">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-base font-bold text-ink">Returns Detail</h3>
                <p className="text-xs text-outline mt-0.5">
                  <span className="font-semibold text-primary">{num(returns?.total)}</span> total returns
                  &nbsp;·&nbsp; Page {page} of {Math.ceil((returns?.total || 1) / 50)}
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <ExportButton
                  label="Export XLSX"
                  buildExport={async () => { const all = await fetchAllReturns(filters); return buildReturnsExport(all, filters); }}
                />
                <div className="flex items-center gap-1 bg-surface-container-low border border-border rounded-lg p-1">
                  <button
                    onClick={() => setPage(p => Math.max(1, p-1))}
                    disabled={page === 1}
                    className="px-3 py-1 text-sm rounded-md font-medium text-secondary disabled:opacity-30 hover:bg-white hover:shadow-sm transition-all"
                  >← Prev</button>
                  <span className="text-sm text-outline px-2 font-medium">{page}</span>
                  <button
                    onClick={() => setPage(p => p+1)}
                    disabled={!returns || returns.data.length < 50 || returns.total <= page * 50}
                    className="px-3 py-1 text-sm rounded-md font-medium text-secondary disabled:opacity-30 hover:bg-white hover:shadow-sm transition-all"
                  >Next →</button>
                </div>
              </div>
            </div>
            <div className="overflow-x-auto">
              {lr ? <Skeleton /> : (
                <table className="finance-table">
                  <thead>
                    <tr className="bg-gradient-to-r from-slate-800 to-slate-700 text-white">
                      {[
                        'Return Date','Order Date','Order Item ID','Category','State','Zone',
                        'Return Type','Return Status','Return Reason','Sub Reason',
                        'Completion','Condition','My Share'
                      ].map(h => (
                        <th key={h} className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap opacity-90">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="text-sm">
                    {(returns?.data || []).map((o, i) => (
                      <tr
                        key={i}
                        className={`border-b border-slate-50 hover:bg-indigo-50/40 transition-colors ${i % 2 === 0 ? 'bg-surface' : 'bg-surface-container-low/30'}`}
                      >
                        <td className="px-4 py-3 text-secondary whitespace-nowrap font-mono text-xs">
                          {o.returnDate || <span className="text-surface">—</span>}
                        </td>
                        <td className="px-4 py-3 text-secondary whitespace-nowrap font-mono text-xs">
                          {o.orderDate || <span className="text-surface">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          {o.orderItemId
                            ? <OrderIdCell id={o.orderItemId} onOpen={setSelectedId} />
                            : <span className="text-surface">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          {o.category
                            ? <span className="bg-indigo-50 text-indigo-700 border border-indigo-200/80 px-2.5 py-1 rounded-full text-xs font-semibold capitalize whitespace-nowrap">{o.category.replace(/_/g, ' ')}</span>
                            : <span className="text-surface">—</span>}
                        </td>
                        <td className="px-4 py-3 text-secondary whitespace-nowrap text-sm">
                          {o.deliveryState || <span className="text-surface">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          {o.shippingZone ? (
                            <span className={`inline-flex items-center px-2.5 py-1 rounded text-xs font-medium ${
                              o.shippingZone === 'Local' ? 'bg-emerald-50 text-emerald-700' :
                              o.shippingZone === 'Regional' ? 'bg-blue-50 text-blue-700' :
                              'bg-surface-container text-secondary'
                            }`}>
                              {o.shippingZone}
                            </span>
                          ) : <span className="text-outline">—</span>}
                        </td>
                        <td className="px-4 py-3"><TypeBadge type={o.returnType} /></td>
                        <td className="px-4 py-3"><StatusBadge status={o.returnStatus} /></td>
                        <td className="px-4 py-3 max-w-[160px]" title={o.returnReason}>
                          {o.returnReason
                            ? <span className="text-ink leading-tight block truncate">{(o.returnReason || '').replace(/_/g, ' ')}</span>
                            : <span className="text-surface">—</span>}
                        </td>
                        <td className="px-4 py-3 max-w-[140px] text-secondary" title={o.returnSubReason}>
                          <span className="block truncate">{(o.returnSubReason || '').replace(/_/g, ' ') || <span className="text-surface">—</span>}</span>
                        </td>
                        <td className="px-4 py-3"><CompletionBadge type={o.returnCompletionType} /></td>
                        <td className="px-4 py-3">
                          {o.finalCondition ? (() => {
                            const cond = o.finalCondition.toLowerCase();
                            const isGood = cond.includes('good') || cond.includes('sellable') || cond.includes('pass') || cond.includes('new');
                            const isBad = cond.includes('damag') || cond.includes('defect') || cond.includes('reject') || cond.includes('fail');
                            const cls = isGood
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                              : isBad
                              ? 'bg-rose-50 text-rose-700 border-rose-100'
                              : 'bg-surface-container-low text-secondary border-border';
                            return (
                              <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${cls}`}>
                                {o.finalCondition.replace(/_/g, ' ')}
                              </span>
                            );
                          })() : <span className="text-surface">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`font-semibold ${+o.myShare > 0 ? 'text-emerald-700' : 'text-outline'}`}>
                            ₹{(+(o.myShare ?? 0)).toFixed(0)}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {(returns?.data || []).length === 0 && !lr && (
                      <tr><td colSpan={13} className="text-center py-12 text-outline">No returns found for selected filters</td></tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
            {/* Bottom pagination */}
            {returns?.total > 50 && (
              <div className="px-5 py-3 border-t border-border flex items-center justify-between bg-surface-container-low/50">
                <span className="text-sm text-outline">
                  Showing {((page-1)*50)+1}–{Math.min(page*50, returns.total)} of {num(returns.total)} returns
                </span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setPage(1)} disabled={page===1} className="px-2 py-1 text-sm rounded border border-border text-secondary disabled:opacity-30 hover:bg-white">«</button>
                  <button onClick={() => setPage(p=>Math.max(1,p-1))} disabled={page===1} className="px-3 py-1 text-sm rounded border border-border text-secondary disabled:opacity-30 hover:bg-white">Prev</button>
                  <span className="px-3 py-1 text-sm bg-primary text-white rounded font-semibold">{page}</span>
                  <button onClick={() => setPage(p=>p+1)} disabled={returns.data.length<50} className="px-3 py-1 text-sm rounded border border-border text-secondary disabled:opacity-30 hover:bg-white">Next</button>
                  <button onClick={() => setPage(Math.ceil(returns.total/50))} disabled={returns.data.length<50} className="px-2 py-1 text-sm rounded border border-border text-secondary disabled:opacity-30 hover:bg-white">»</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── SKU Summary tab ──────────────────────────────────────────────────── */}
      {tab === 'sku' && (
        <SkuSummaryView filters={filters} dep={dep} />
      )}

      {/* (Tabs migrated to other pages) */}
    </div>
    <OrderDetailDrawer orderItemId={selectedId} onClose={() => setSelectedId(null)} />
    </>
  );
}

// ── SKU Summary Pivot Table ───────────────────────────────────────────────────
function SkuSummaryView({ filters, dep }) {
  const [search, setSearch]   = useState('');
  const [topN, setTopN]       = useState(50);
  const [selectedSku, setSelectedSku] = useState(null);
  const [skuView, setSkuView] = useState('listing'); // 'listing' | 'master' | 'both'

  const { data, loading } = useFetch(
    () => fetchSkuReturnSummary(filters, skuView),
    [...dep, skuView]
  );

  const months  = data?.months  || [];
  const rawData = data?.data    || [];

  // Build pivot: { sku → { sku, masterSku, [month]: {...} } }
  const pivot = useMemo(() => {
    const map = {};
    rawData.forEach(r => {
      const key = r.sku;
      if (!map[key]) map[key] = { sku: r.sku, masterSku: r.masterSku, totalGross: 0, totalReturns: 0, totalRto: 0 };
      map[key][r.month] = r;
      map[key].totalGross   += r.gross;
      map[key].totalReturns += r.returns;
      map[key].totalRto     += r.rto;
    });
    return map;
  }, [rawData]);

  // Month-level totals for summary row
  const monthTotals = useMemo(() => {
    const t = {};
    months.forEach(m => {
      t[m] = { gross: 0, returns: 0, rto: 0, net: 0 };
      rawData.filter(r => r.month === m).forEach(r => {
        t[m].gross   += r.gross;
        t[m].returns += r.returns;
        t[m].rto     += r.rto;
        t[m].net     += r.net;
      });
      t[m].returnPct = t[m].gross > 0 ? ((t[m].returns + t[m].rto) / t[m].gross * 100).toFixed(1) : '0.0';
    });
    return t;
  }, [rawData, months]);

  const skuRows = useMemo(() =>
    Object.values(pivot)
      .filter(r => !search || r.sku.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => b.totalGross - a.totalGross)
      .slice(0, topN),
    [pivot, search, topN]
  );

  if (loading) return <div className="space-y-3 animate-pulse">{Array.from({length:8}).map((_,i) => <div key={i} className="h-8 bg-surface-container rounded" />)}</div>;
  if (!months.length) return (
    <div className="bg-surface-container-low rounded-xl border border-border p-10 text-center">
      <p className="text-secondary font-medium">No data available</p>
      <p className="text-outline text-sm mt-1">Upload orders and returns data first</p>
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <svg className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-outline" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search SKU…"
            className="pl-8 pr-3 py-1.5 text-sm border border-border rounded-lg bg-surface text-ink w-52 focus:outline-none focus:border-primary"
          />
        </div>
        <select
          value={topN}
          onChange={e => setTopN(+e.target.value)}
          className="text-sm border border-border rounded-lg px-3 py-1.5 bg-surface text-secondary"
        >
          {[25,50,100,200,9999].map(n => <option key={n} value={n}>{n === 9999 ? 'All SKUs' : `Top ${n} SKUs`}</option>)}
        </select>

        {/* SKU view toggle */}
        <div className="flex items-center gap-1 bg-surface-container rounded-lg p-0.5 ml-auto">
          {[
            { v: 'listing', label: 'Listing SKU' },
            { v: 'master',  label: 'Master SKU' },
            { v: 'both',    label: 'Both' },
          ].map(({ v, label }) => (
            <button key={v} onClick={() => setSkuView(v)}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
                skuView === v ? 'bg-surface text-ink shadow-sm' : 'text-secondary hover:text-ink'
              }`}>
              {label}
            </button>
          ))}
        </div>

        <span className="text-xs text-outline">
          {skuRows.length} of {Object.keys(pivot).length} SKUs · {months.length} month{months.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Pivot Table */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
          <table className="text-xs border-collapse min-w-full">
            <thead className="sticky top-0 z-10">
              {/* Row 1: Month headers */}
              <tr className="bg-primary text-white">
                <th className="sticky left-0 z-20 bg-primary text-left px-3 py-2.5 font-semibold whitespace-nowrap min-w-[220px] border-r border-primary">
                  {skuView === 'master' ? 'Master SKU' : skuView === 'both' ? 'Master SKU / Listing SKU' : 'Listing SKU'}
                </th>
                {months.map(m => (
                  <th key={m} colSpan={5} className="text-center px-3 py-2.5 font-semibold border-l border-primary whitespace-nowrap">
                    {m}
                  </th>
                ))}
              </tr>
              {/* Row 2: Totals */}
              <tr className="bg-primary text-surface border-b border-primary">
                <td className="sticky left-0 z-20 bg-primary px-3 py-2.5 font-semibold border-r border-primary whitespace-nowrap text-surface">
                  TOTAL
                </td>
                {months.flatMap(m => {
                  const t = monthTotals[m];
                  return [
                    <td key={m+'g'} className="text-center px-3 py-2.5 border-l border-primary font-semibold text-indigo-200">{t.gross.toLocaleString()}</td>,
                    <td key={m+'r'} className="text-center px-3 py-2.5 font-semibold text-orange-200">{t.returns.toLocaleString()}</td>,
                    <td key={m+'t'} className="text-center px-3 py-2.5 font-semibold text-purple-200">{t.rto.toLocaleString()}</td>,
                    <td key={m+'n'} className="text-center px-3 py-2.5 font-semibold text-emerald-200">{t.net.toLocaleString()}</td>,
                    <td key={m+'p'} className="text-center px-3 py-2.5 font-semibold text-rose-200">{t.returnPct}%</td>,
                  ];
                })}
              </tr>
              {/* Row 3: Sub-headers */}
              <tr className="bg-surface-container border-b border-border">
                <th className="sticky left-0 z-20 bg-surface-container px-3 py-2.5 border-r border-border" />
                {months.flatMap(m => [
                  <th key={m+'gh'} className="px-3 py-2.5 text-center text-secondary font-medium whitespace-nowrap border-l border-border bg-indigo-50/60">Gross</th>,
                  <th key={m+'rh'} className="px-3 py-2.5 text-center text-secondary font-medium whitespace-nowrap bg-orange-50/40">Return</th>,
                  <th key={m+'th'} className="px-3 py-2.5 text-center text-secondary font-medium whitespace-nowrap bg-purple-50/40">RTO</th>,
                  <th key={m+'nh'} className="px-3 py-2.5 text-center text-secondary font-medium whitespace-nowrap bg-emerald-50/40">Net Sales</th>,
                  <th key={m+'ph'} className="px-3 py-2.5 text-center text-secondary font-medium whitespace-nowrap bg-rose-50/40">Return%</th>,
                ])}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {skuRows.map((row, ri) => (
                <tr key={row.sku} className={`hover:bg-indigo-50/30 ${ri % 2 === 0 ? '' : 'bg-surface-container-low/40'}`}>
                  <td className="sticky left-0 z-10 bg-inherit px-3 py-2.5 border-r border-border whitespace-nowrap max-w-[240px]">
                    <button
                      onClick={() => setSelectedSku(row.sku)}
                      title={`View all orders for ${row.sku}`}
                      className="flex items-center gap-1.5 group w-full text-left"
                    >
                      <div className="min-w-0">
                        {skuView === 'both' && row.masterSku && row.masterSku !== row.sku && (
                          <span className="block text-xs text-outline font-mono truncate leading-tight">
                            {row.masterSku}
                          </span>
                        )}
                        <span className="font-medium text-primary group-hover:text-primary group-hover:underline truncate text-xs block">
                          {row.sku}
                        </span>
                      </div>
                      <svg className="w-3 h-3 text-indigo-400 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </button>
                  </td>
                  {months.flatMap(m => {
                    const cell = row[m];
                    if (!cell) return [
                      <td key={m+'g'} className="text-center px-3 py-2.5 text-surface border-l border-border">—</td>,
                      <td key={m+'r'} className="text-center px-3 py-2.5 text-surface">—</td>,
                      <td key={m+'t'} className="text-center px-3 py-2.5 text-surface">—</td>,
                      <td key={m+'n'} className="text-center px-3 py-2.5 text-surface">—</td>,
                      <td key={m+'p'} className="text-center px-3 py-2.5 text-surface">—</td>,
                    ];
                    const pctColor = cell.returnPct > 25 ? 'text-rose-700 font-bold'
                      : cell.returnPct > 15 ? 'text-orange-600 font-semibold'
                      : cell.returnPct > 8  ? 'text-amber-600'
                      : 'text-emerald-600';
                    return [
                      <td key={m+'g'} className="text-center px-3 py-2.5 text-primary font-medium border-l border-border">{cell.gross.toLocaleString()}</td>,
                      <td key={m+'r'} className="text-center px-3 py-2.5 text-orange-600">{cell.returns || '—'}</td>,
                      <td key={m+'t'} className="text-center px-3 py-2.5 text-purple-600">{cell.rto || '—'}</td>,
                      <td key={m+'n'} className="text-center px-3 py-2.5 text-emerald-700 font-medium">{cell.net.toLocaleString()}</td>,
                      <td key={m+'p'} className={`text-center px-3 py-2.5 ${pctColor}`}>{cell.returnPct.toFixed(1)}%</td>,
                    ];
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Legend */}
      <div className="flex gap-4 text-xs text-outline flex-wrap">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-primary-container inline-block"/>Gross Sale In Units</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-orange-400 inline-block"/>Customer Return</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-purple-400 inline-block"/>RTO (Courier Return)</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-emerald-400 inline-block"/>Net Sales</span>
        <span className="flex items-center gap-1 ml-2 text-rose-500">Return% &gt;25% = high risk</span>
        <span className="flex items-center gap-1 text-orange-500">Return% 15–25% = watch</span>
        <span className="flex items-center gap-1 text-emerald-500">Return% &lt;8% = healthy</span>
        <span className="flex items-center gap-1 ml-4 text-primary font-medium">↑ Click any SKU name to see all its orders</span>
        <span className="flex items-center gap-1 text-outline">· Use the Listing / Master / Both toggle to switch grouping (requires SKU Master upload)</span>
      </div>

      {selectedSku && (
        <SkuDrawer sku={selectedSku} onClose={() => setSelectedSku(null)} />
      )}
    </div>
  );
}

// ── SKU Drawer ───────────────────────────────────────────────────────────────
function SkuDrawer({ sku, onClose }) {
  const [page, setPage] = useState(1);
  const [drawerData, setDrawerData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedOrderId, setSelectedOrderId] = useState(null);

  const load = useCallback((pg) => {
    setLoading(true); setError(null);
    fetchSkuOrders(sku, pg)
      .then(d => { setDrawerData(d); setLoading(false); })
      .catch(e => { setError(e?.response?.data?.error || e.message); setLoading(false); });
  }, [sku]);

  useEffect(() => { load(page); }, [load, page]);

  useEffect(() => {
    const h = e => { if (e.key === 'Escape') { if (selectedOrderId) setSelectedOrderId(null); else onClose(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, selectedOrderId]);

  const totalPages = drawerData ? Math.ceil(drawerData.total / 50) : 1;
  const returnRate = drawerData?.returnRate || 0;
  const rateColor  = returnRate > 25 ? 'text-rose-600' : returnRate > 15 ? 'text-orange-500' : returnRate > 8 ? 'text-amber-500' : 'text-emerald-600';

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 modal-backdrop z-40" onClick={() => { if (!selectedOrderId) onClose(); }} />

      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-full max-w-3xl bg-surface shadow-2xl z-50 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="shrink-0 bg-gradient-to-r from-slate-800 to-slate-700 px-6 py-4">
          <div className="flex items-start justify-between">
            <div>
            <p className="text-xs text-outline uppercase tracking-widest font-semibold mb-1">SKU Detail</p>
              <h2 className="text-white font-bold text-base font-mono leading-tight">{sku}</h2>
            </div>
            <button onClick={onClose} className="text-outline hover:text-white transition-colors p-1 rounded-lg hover:bg-secondary mt-0.5">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Summary KPIs */}
          {drawerData && (
            <div className="grid grid-cols-4 gap-3 mt-4">
              {[
                { label: 'Total Orders', value: drawerData.totalOrders.toLocaleString('en-IN'), color: 'text-white' },
                { label: 'Returns',      value: drawerData.returnCount.toLocaleString('en-IN'),  color: 'text-orange-300' },
                { label: 'RTO',          value: drawerData.courierReturns.toLocaleString('en-IN'), color: 'text-purple-300' },
                { label: 'Return Rate',  value: `${returnRate}%`, color: rateColor.replace('text-', 'text-') },
              ].map(k => (
                <div key={k.label} className="bg-white/10 rounded-lg px-3 py-2">
                  <p className="text-xs text-outline uppercase tracking-wide">{k.label}</p>
                  <p className={`text-lg font-bold mt-0.5 ${k.color === rateColor ? rateColor : k.color}`}>{k.value}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Sub-header with pagination */}
        <div className="shrink-0 px-5 py-3 border-b border-border flex items-center justify-between bg-surface-container-low">
          <p className="text-sm text-secondary">
            <span className="font-semibold text-ink">{drawerData?.total?.toLocaleString('en-IN') || '—'}</span> orders total
            &nbsp;·&nbsp; Page {page} of {totalPages}
          </p>
          <div className="flex items-center gap-1">
            <button onClick={() => setPage(1)} disabled={page===1} className="px-2 py-1 text-sm border border-border rounded disabled:opacity-30 hover:bg-white">«</button>
            <button onClick={() => setPage(p=>p-1)} disabled={page===1} className="px-3 py-1 text-sm border border-border rounded disabled:opacity-30 hover:bg-white">Prev</button>
            <span className="px-3 py-1 text-sm bg-primary text-white rounded font-semibold">{page}</span>
            <button onClick={() => setPage(p=>p+1)} disabled={!drawerData || drawerData.data.length < 50 || page >= totalPages} className="px-3 py-1 text-sm border border-border rounded disabled:opacity-30 hover:bg-white">Next</button>
            <button onClick={() => setPage(totalPages)} disabled={!drawerData || drawerData.data.length < 50 || page >= totalPages} className="px-2 py-1 text-sm border border-border rounded disabled:opacity-30 hover:bg-white">»</button>
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="p-6 space-y-2">
              {Array.from({length:10}).map((_,i) => <div key={i} className="h-10 bg-surface-container rounded animate-pulse" />)}
            </div>
          )}
          {error && (
            <div className="p-6 text-rose-600 text-sm">{error}</div>
          )}
          {!loading && !error && (
            <table className="finance-table">
              <thead className="sticky top-0">
                <tr className="bg-surface-container border-b border-border">
                  {['Order Date','Order Item ID','State','Status','Return Type','Return Reason','Completion','Invoice','My Share'].map(h => (
                    <th key={h} className="text-left px-3 py-2.5 text-secondary font-semibold whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="text-sm">
                {(drawerData?.data || []).map((o, i) => (
                  <tr key={i} className={`border-b border-slate-50 hover:bg-indigo-50/40 transition-colors ${i%2===0?'bg-surface':'bg-surface-container-low/30'}`}>
                    <td className="px-3 py-2.5 text-secondary font-mono text-xs whitespace-nowrap">{o.orderDate || '—'}</td>
                    <td className="px-3 py-2.5">
                      <button
                        onClick={() => setSelectedOrderId(o.orderItemId)}
                        className="font-mono text-xs text-primary hover:text-primary hover:underline text-left"
                      >
                        {o.orderItemId}
                      </button>
                    </td>
                    <td className="px-3 py-2.5 text-secondary text-sm whitespace-nowrap">{o.deliveryState || '—'}</td>
                    <td className="px-3 py-2.5">
                      {o.orderStatus
                        ? <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${
                            o.orderStatus.toLowerCase().includes('cancel') ? 'bg-rose-50 text-rose-700 border-rose-100'
                            : o.orderStatus.toLowerCase().includes('deliver') ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                            : 'bg-surface-container-low text-secondary border-border'}`}>
                            {o.orderStatus}
                          </span>
                        : <span className="text-outline">—</span>}
                    </td>
                    <td className="px-3 py-2.5"><TypeBadge type={o.returnType} /></td>
                    <td className="px-3 py-2.5 max-w-[150px]">
                      <span className="block truncate text-secondary" title={o.returnReason}>
                        {(o.returnReason || '').replace(/_/g, ' ') || <span className="text-outline">—</span>}
                      </span>
                    </td>
                    <td className="px-3 py-2.5"><CompletionBadge type={o.returnCompletionType} /></td>
                    <td className="px-3 py-2.5 text-ink font-medium whitespace-nowrap">
                      ₹{(+o.invoiceAmount || 0).toFixed(0)}
                    </td>
                    <td className="px-3 py-2.5 font-semibold whitespace-nowrap">
                      <span className={+o.myShare > 0 ? 'text-emerald-700' : 'text-outline'}>
                        ₹{(+o.myShare || 0).toFixed(0)}
                      </span>
                    </td>
                  </tr>
                ))}
                {(drawerData?.data || []).length === 0 && (
                  <tr><td colSpan={9} className="text-center py-10 text-outline">No orders found</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Nested order detail drawer */}
      {selectedOrderId && (
        <OrderDetailDrawer orderItemId={selectedOrderId} onClose={() => setSelectedOrderId(null)} />
      )}
    </>
  );
}

// ── Badges ────────────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  if (!status) return <span className="text-outline">—</span>;
  const map = {
    completed:  'bg-emerald-50 text-emerald-700 border-emerald-100',
    cancelled:  'bg-rose-50 text-rose-700 border-rose-100',
    init:       'bg-amber-50 text-amber-700 border-amber-100',
    processing: 'bg-sky-50 text-sky-700 border-sky-100',
    approved:   'bg-emerald-50 text-emerald-700 border-emerald-100',
    rejected:   'bg-rose-50 text-rose-700 border-rose-100',
  };
  const cls = map[status?.toLowerCase()] || 'bg-surface-container-low text-secondary border-border';
  return <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${cls} capitalize`}>{status}</span>;
}
function TypeBadge({ type }) {
  if (!type) return <span className="text-outline">—</span>;
  const lower = type.toLowerCase();
  const isCustomer = lower.includes('customer') || type === 'Return';
  const isRTO = lower.includes('courier') || lower.includes('rto');
  const label = isCustomer ? 'Customer' : isRTO ? 'RTO' : type;
  const cls = isCustomer
    ? 'bg-orange-50 text-orange-700 border-orange-100'
    : isRTO
    ? 'bg-purple-50 text-purple-700 border-purple-100'
    : 'bg-slate-50 text-slate-700 border-slate-200';
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${cls} flex items-center gap-1 w-fit`}>
      <span className={`w-1.5 h-1.5 rounded-full inline-block ${isCustomer ? 'bg-orange-400' : isRTO ? 'bg-purple-400' : 'bg-slate-400'}`} />
      {label}
    </span>
  );
}
function CompletionBadge({ type }) {
  if (!type) return <span className="text-outline">—</span>;
  const map = {
    refund:   'bg-rose-50 text-rose-700 border-rose-100',
    exchange: 'bg-sky-50 text-sky-700 border-sky-100',
    replace:  'bg-amber-50 text-amber-700 border-amber-100',
    reject:   'bg-surface-container-low text-secondary border-border',
  };
  const key = Object.keys(map).find(k => type.toLowerCase().includes(k));
  return <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${map[key] || 'bg-surface-container-low text-secondary border-border'} capitalize`}>{type.replace(/_/g, ' ')}</span>;
}
function Skeleton() {
  return <div className="p-6 space-y-3">{Array.from({length:8}).map((_,i) => <div key={i} className="h-8 bg-surface-container rounded animate-pulse" />)}</div>;
}

function SPFDIcon() { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>; }
function SPFRIcon() { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>; }
function GoodIcon() { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/></svg>; }
function BadIcon()  { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>; }

// ── Icons ─────────────────────────────────────────────────────────────────────
function ReturnIcon()   { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>; }
function RateIcon()     { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>; }
function CustomerIcon() { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>; }
function CourierIcon()  { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>; }
