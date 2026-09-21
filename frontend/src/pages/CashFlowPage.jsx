import { useState, useMemo, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, LineChart, Line, Legend,
  ComposedChart, Area,
} from 'recharts';
import { fetchCashFlow } from '../api/client';
import { matchesMarketplace } from '../utils/marketplace';
import useFetch from '../hooks/useFetch';
import { useFilters } from '../context/FilterContext';
import PageHeader from '../components/PageHeader';
import { useAnimatedDisplayValue } from '../hooks/useAnimatedDisplayValue';
import {
  currencyCompact as fmtK,
  formatDateFull as fmtDateFull,
  formatDateShort as fmtDate,
  formatNumber as fmt,
} from '../utils/format';

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Marketplace config ────────────────────────────────────────────────────────
const MPs = [
  { id: 'all',       label: 'All',         pill: 'bg-primary text-white',    dot: '#6366f1' },
  { id: 'flipkart',  label: 'Flipkart',    pill: 'bg-amber-500 text-white',     dot: '#f59e0b' },
  { id: 'amazon',    label: 'Amazon',      pill: 'bg-orange-500 text-white',    dot: '#f97316' },
  { id: 'myntra_vb', label: 'Myntra (VB)', pill: 'bg-pink-500 text-white',      dot: '#ec4899' },
  { id: 'myntra_ej', label: 'Myntra (EJ)', pill: 'bg-rose-500 text-white',      dot: '#be185d' },
  { id: 'meesho',    label: 'Meesho',      pill: 'bg-purple-500 text-white',    dot: '#a855f7' },
];
const MP_DOT = { flipkart: '#f59e0b', amazon: '#f97316', myntra: '#ec4899', myntra_vb: '#ec4899', myntra_ej: '#be185d', meesho: '#a855f7', all: '#6366f1' };
const MP_CYCLE = { flipkart: 7, amazon: 14, myntra: 21, myntra_vb: 21, myntra_ej: 21, meesho: 7, all: 10 };

// ── Shared components ─────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, color = 'slate', icon, alert }) {
  const colorMap = {
    slate:   'bg-surface border-border',
    indigo:  'bg-primary-container border-primary',
    emerald: 'bg-emerald-50 border-emerald-200',
    rose:    'bg-rose-50 border-rose-200',
    amber:   'bg-amber-50 border-amber-200',
    violet:  'bg-violet-50 border-violet-200',
    orange:  'bg-orange-50 border-orange-200',
  };
  const valColor = { slate: 'text-ink', indigo: 'text-primary', emerald: 'text-emerald-700', rose: 'text-rose-600', amber: 'text-amber-700', violet: 'text-violet-700', orange: 'text-orange-700' };
  const animatedValue = useAnimatedDisplayValue(value);
  return (
    <div className={`rounded-xl border px-5 py-4 shadow-sm ${colorMap[color]} relative`}>
      {alert && <span className="absolute top-3 right-3 h-2 w-2 rounded-full bg-red-400 animate-ping" />}
      <div className="flex items-start justify-between mb-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-outline">{label}</p>
        {icon && <span className="text-lg opacity-50">{icon}</span>}
      </div>
      <p className={`text-financial-lg font-semibold leading-tight tabular-nums ${valColor[color]}`}>{animatedValue}</p>
      {sub && <p className="text-xs text-outline mt-0.5">{sub}</p>}
    </div>
  );
}

function SectionCard({ title, sub, children, className = '' }) {
  return (
    <div className={`bg-surface rounded-xl border border-border shadow-sm p-5 ${className}`}>
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

function Empty({ msg = 'No data yet', sub }) {
  return (
    <div className="py-10 text-center">
      <p className="text-outline text-sm">{msg}</p>
      {sub && <p className="text-surface text-xs mt-1">{sub}</p>}
    </div>
  );
}

function MpFilter_UNUSED_REMOVED() { return null; }

// ── Settlement Timeline ───────────────────────────────────────────────────────
function SettlementTimeline({ history, mp }) {
  const [view, setView] = useState('weekly');

  const chartData = useMemo(() => {
    if (!history?.length) return [];
    const mp2 = mp === 'all' ? null : mp;
    const filtered = mp2 ? history.filter(r => matchesMarketplace(r.marketplace, mp2)) : history;

    if (view === 'daily') {
      return filtered.map(r => ({
        date: fmtDate(r.date),
        inflow: +r.inflow,
        outflow: +r.outflow,
        net: +r.net,
        full: r.date,
      })).slice(-60);
    }

    // Weekly aggregation
    const weekly = {};
    for (const r of filtered) {
      const d = new Date(r.date);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay() + 1);
      const key = weekStart.toISOString().slice(0, 10);
      if (!weekly[key]) weekly[key] = { date: key, inflow: 0, outflow: 0, net: 0 };
      weekly[key].inflow  += +r.inflow;
      weekly[key].outflow += +r.outflow;
      weekly[key].net     += +r.net;
    }
    return Object.values(weekly)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(r => ({ ...r, date: fmtDate(r.date) }))
      .slice(-16);
  }, [history, mp, view]);

  const total30  = useMemo(() => {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    const mp2 = mp === 'all' ? null : mp;
    return (history || [])
      .filter(r => new Date(r.date) >= cutoff && matchesMarketplace(r.marketplace, mp2))
      .reduce((s, r) => s + +r.inflow, 0);
  }, [history, mp]);

  return (
    <SectionCard
      title="Settlement Timeline"
      sub={`Cash received in last 120 days — ₹${(total30/100000).toFixed(1)}L in last 30 days`}
    >
      <div className="flex items-center gap-2 mb-4">
        {['daily', 'weekly'].map(v => (
          <button key={v} onClick={() => setView(v)}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${view === v ? 'bg-primary text-white' : 'bg-surface-container text-secondary hover:bg-surface-container-high'}`}>
            {v.charAt(0).toUpperCase() + v.slice(1)}
          </button>
        ))}
      </div>
      {chartData.length === 0 ? <Empty msg="No settlement data" sub="Upload FK settlement reports to see timeline" /> : (
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={chartData} barGap={2}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8' }} />
            <YAxis tickFormatter={v => `₹${(v/1000).toFixed(0)}K`} tick={{ fontSize: 10, fill: '#94a3b8' }} />
            <Tooltip
              formatter={(v, n) => [fmtK(v), n === 'inflow' ? 'Inflow' : n === 'outflow' ? 'Outflow' : 'Net']}
              contentStyle={{ borderRadius: 8, fontSize: 12 }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="inflow"  name="Inflow"  fill="#10b981" radius={[3, 3, 0, 0]} stackId="s" />
            <Bar dataKey="outflow" name="Outflow" fill="#f43f5e" radius={[3, 3, 0, 0]} />
            <Line dataKey="net"    name="Net"     stroke="#6366f1" strokeWidth={2} dot={false} type="monotone" />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </SectionCard>
  );
}

function matchesMp(rowMp, targetMp) {
  return matchesMarketplace(rowMp, targetMp);
}

function formatSpfReason(r) {
  if (!r) return 'Other Claims';
  const str = String(r).trim();
  const map = {
    'REVERSAL_REIMBURSEMENT': 'Reversal Reimbursement (Amazon)',
    'Reimbursement for Lost packages': 'Lost Packages Reimbursement (Amazon)',
    'SAFE-T Reimbursement': 'SAFE-T Claim Reimbursement (Amazon)',
    'TDS Reimbursement': 'TDS Reimbursement (Amazon)',
    'FREE_REPLACEMENT_REFUND_ITEMS': 'Free Replacement Refund (Amazon)',
    'WAREHOUSE_DAMAGE': 'Warehouse Damage Claim (Amazon)',
    'PAYMENT_RETRACTION_ITEMS': 'Payment Retraction Adjustment',
    'ForwardAutoSPF': 'Forward Auto-SPF Protection (Myntra)',
    'spf_rbnr': 'Return SPF Claim - RBNR (Myntra)',
    'MainProduct_WareHouseLost': 'Warehouse Lost (Flipkart)',
    'MainProduct_WrongProductReceived': 'Wrong Product Received (Flipkart)',
    'MainProduct_Damaged': 'Damaged Product (Flipkart)',
    'Order Protection Fund': 'Order Protection Fund',
    'Settlement Claim': 'Settlement Claim',
    'Meesho Claim': 'Settlement Claim (Meesho)',
  };
  if (map[str]) return map[str];
  if (str.startsWith('PPMP') || str.startsWith('SJIT')) return `Settlement SPF Adjustment (${str})`;
  return str.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── SPF Recovery (tabbed: Order SPF vs Non-Order SPF / Reimbursements) ─────────
function SpfRecovery({ spfTotals, spfReasons, orderSpfSummary, orderSpfDetail, mp }) {
  const [tab, setTab] = useState('order'); // 'order' | 'nonorder'

  const spfSubtitle = useMemo(() => {
    if (mp === 'amazon') return 'Amazon SAFE-T Claims & FBA Inventory Reimbursements (Reversals, Lost, Damaged)';
    if (mp === 'myntra_vb') return 'Myntra (VB - 10708) Forward Auto-SPF & Dispute Claims (RBNR)';
    if (mp === 'myntra_ej') return 'Myntra (EJ - 45833) Forward Auto-SPF & Dispute Claims (RBNR)';
    if (mp === 'myntra') return 'Myntra Forward Auto-SPF & Dispute Claims (RBNR)';
    if (mp === 'flipkart') return 'Flipkart Seller Protection Fund (SPF) & Settlement Protection';
    if (mp === 'meesho') return 'Meesho Order Claims & Return Compensations';
    return 'Consolidated Claims & Reimbursements across Flipkart, Amazon, Myntra & Meesho';
  }, [mp]);

  const nonOrderSourceSub = useMemo(() => {
    if (mp === 'amazon') return 'from Amazon settlement reports';
    if (mp?.startsWith('myntra')) return 'from Myntra settlement invoices (NOD / RBNR)';
    if (mp === 'flipkart') return 'from fk_spf_claims table';
    if (mp === 'meesho') return 'from Meesho settlement items';
    return 'from marketplace claims & reports';
  }, [mp]);

  const orderSourceSub = useMemo(() => {
    if (mp === 'amazon') return 'order-level SAFE-T & FBA reimbursements';
    if (mp?.startsWith('myntra')) return 'forward auto-SPF credited against orders';
    if (mp === 'flipkart') return 'protection_fund credited per order item';
    if (mp === 'meesho') return 'order claims credited per item';
    return 'protection fund / claims per item';
  }, [mp]);

  // ── Non-order SPF / Claims ──
  const nonOrderTotals = useMemo(() => {
    if (!spfTotals?.length) return { claims: 0, recovered: 0 };
    const rows = spfTotals.filter(r => matchesMp(r.marketplace, mp));
    return rows.reduce((acc, r) => ({
      claims: acc.claims + +r.total_claims,
      recovered: acc.recovered + +r.total_recovered,
    }), { claims: 0, recovered: 0 });
  }, [spfTotals, mp]);

  const nonOrderReasons = useMemo(() => {
    if (!spfReasons?.length) return [];
    const rows = spfReasons.filter(r => matchesMp(r.marketplace, mp));
    const merged = rows.reduce((acc, r) => {
      const label = formatSpfReason(r.protection_reason);
      const ex = acc.find(a => a.label === label);
      if (ex) { ex.count += +r.count; ex.value += +r.value; }
      else acc.push({ ...r, label, count: +r.count, value: +r.value });
      return acc;
    }, []);
    return merged.sort((a, b) => b.value - a.value).slice(0, 15);
  }, [spfReasons, mp]);

  // ── Order SPF / Claims ──
  const orderSpfTotals = useMemo(() => {
    if (!orderSpfSummary?.length) return { orders: 0, recovered: 0 };
    const rows = orderSpfSummary.filter(r => matchesMp(r.marketplace, mp));
    return rows.reduce((acc, r) => ({
      orders: acc.orders + +r.total_orders,
      recovered: acc.recovered + +r.total_recovered,
    }), { orders: 0, recovered: 0 });
  }, [orderSpfSummary, mp]);

  const orderSpfRows = useMemo(() => {
    if (!orderSpfDetail?.length) return [];
    return orderSpfDetail.filter(r => matchesMp(r.marketplace, mp));
  }, [orderSpfDetail, mp]);

  const REASON_COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316', '#f59e0b', '#10b981', '#06b6d4', '#3b82f6', '#64748b'];

  return (
    <SectionCard
      title={mp === 'amazon' ? 'Amazon Reimbursements & SAFE-T Recovery' : 'SPF & Reimbursements Recovery'}
      sub={spfSubtitle}
    >
      {/* Tabs */}
      <div className="flex gap-1 mb-5 p-1 bg-surface-container rounded-xl w-fit">
        <button
          onClick={() => setTab('order')}
          className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${tab === 'order' ? 'bg-primary text-white shadow-sm' : 'text-secondary hover:text-ink hover:bg-white'}`}
        >
          {mp === 'amazon' ? 'Order Reimbursements' : mp?.startsWith('myntra') ? 'Order Auto-SPF' : 'Order Claims / SPF'}
        </button>
        <button
          onClick={() => setTab('nonorder')}
          className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${tab === 'nonorder' ? 'bg-emerald-600 text-white shadow-sm' : 'text-secondary hover:text-ink hover:bg-white'}`}
        >
          {mp === 'amazon' ? 'FBA & Standalone Claims' : mp?.startsWith('myntra') ? 'Dispute Claims (RBNR)' : 'Non-Order / Standalone Claims'}
        </button>
      </div>

      {tab === 'order' ? (
        /* ── Order SPF Panel ── */
        <>
          <div className="grid grid-cols-2 gap-4 mb-5">
            <div className="rounded-xl bg-primary-container border border-primary p-4">
              <p className="text-[10px] font-semibold text-primary uppercase tracking-wider mb-1">
                {mp === 'amazon' ? 'Total Order Reimbursements' : 'Total Recovered (Order SPF)'}
              </p>
              <p className="text-financial-lg font-semibold text-primary tabular-nums">{fmtK(orderSpfTotals.recovered)}</p>
              <p className="text-xs text-indigo-400 mt-0.5">from {fmt(orderSpfTotals.orders)} orders / items</p>
            </div>
            <div className="rounded-xl bg-surface-container-low border border-border p-4">
              <p className="text-[10px] font-semibold text-outline uppercase tracking-wider mb-1">Avg Per Order</p>
              <p className="text-financial-lg font-semibold text-ink tabular-nums">
                {orderSpfTotals.orders ? fmtK(orderSpfTotals.recovered / orderSpfTotals.orders) : '—'}
              </p>
              <p className="text-xs text-outline mt-0.5">{orderSourceSub}</p>
            </div>
          </div>
          <p className="text-xs font-semibold text-secondary mb-2">Top Items by Recovery Amount</p>
          {orderSpfRows.length === 0 ? (
            <Empty msg="No order-level recoveries found" sub="Appears when order reimbursements or protection fund are credited" />
          ) : (
            <div className="overflow-auto max-h-64">
              <table className="finance-table">
                <thead className="sticky top-0 bg-surface">
                  <tr className="text-outline border-b border-border">
                    <th className="text-left py-2 font-medium">Order Item ID</th>
                    {mp === 'all' && <th className="text-left py-2 font-medium">Portal</th>}
                    <th className="text-left py-2 font-medium">Claim Type / Reason</th>
                    <th className="text-left py-2 font-medium">SKU</th>
                    <th className="text-left py-2 font-medium">Category</th>
                    <th className="text-left py-2 font-medium">State</th>
                    <th className="text-left py-2 font-medium">Date</th>
                    <th className="text-right py-2 font-medium">Invoice</th>
                    <th className="text-right py-2 font-medium">Recovered</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {orderSpfRows.map((r, i) => (
                    <tr key={i} className="hover:bg-surface-container-low">
                      <td className="py-2 font-mono text-[10px] text-secondary max-w-[120px] truncate" title={r.order_item_id || r.order_id}>
                        {r.order_item_id || r.order_id}
                      </td>
                      {mp === 'all' && (
                        <td className="py-2 text-[10px] uppercase font-semibold text-outline">
                          {r.marketplace?.replace('_', ' ')}
                        </td>
                      )}
                      <td className="py-2 text-xs font-medium text-ink max-w-[140px] truncate" title={r.claim_reason}>
                        {formatSpfReason(r.claim_reason)}
                      </td>
                      <td className="py-2 text-secondary max-w-[90px] truncate" title={r.sku}>{r.sku || '—'}</td>
                      <td className="py-2 text-secondary max-w-[90px] truncate" title={r.category}>{r.category || '—'}</td>
                      <td className="py-2 text-outline whitespace-nowrap">{r.delivery_state || '—'}</td>
                      <td className="py-2 text-outline whitespace-nowrap">{r.payment_date || '—'}</td>
                      <td className="py-2 text-right text-secondary">{fmtK(r.final_invoice_amount)}</td>
                      <td className="py-2 text-right font-bold text-primary">{fmtK(r.spf_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        /* ── Non-Order SPF Panel ── */
        <>
          <div className="grid grid-cols-2 gap-4 mb-5">
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4">
              <p className="text-[10px] font-semibold text-emerald-500 uppercase tracking-wider mb-1">
                {mp === 'amazon' ? 'Total FBA & Standalone Reimbursements' : 'Total Recovered (Non-Order / Standalone)'}
              </p>
              <p className="text-2xl font-bold text-emerald-700">{fmtK(nonOrderTotals.recovered)}</p>
              <p className="text-xs text-emerald-500 mt-0.5">{fmt(nonOrderTotals.claims)} claims & reimbursements</p>
            </div>
            <div className="rounded-xl bg-surface-container-low border border-border p-4">
              <p className="text-[10px] font-semibold text-outline uppercase tracking-wider mb-1">Avg Per Claim</p>
              <p className="text-financial-lg font-semibold text-ink tabular-nums">
                {nonOrderTotals.claims ? fmtK(nonOrderTotals.recovered / nonOrderTotals.claims) : '—'}
              </p>
              <p className="text-xs text-outline mt-0.5">{nonOrderSourceSub}</p>
            </div>
          </div>
          {nonOrderReasons.length === 0 ? (
            <Empty msg="No claims or reimbursements found" sub="Reports appear when claims and dispute adjustments are uploaded" />
          ) : (
            <>
              <p className="text-xs font-semibold text-secondary mb-3">Breakdown by Claim Type / Reason</p>
              <div className="space-y-2">
                {nonOrderReasons.map((r, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: REASON_COLORS[i % REASON_COLORS.length] }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-xs text-ink truncate font-medium">{r.label}</span>
                        <span className="text-xs font-bold text-emerald-700 ml-2 shrink-0">{fmtK(r.value)}</span>
                      </div>
                      <div className="h-1.5 bg-surface-container rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${(r.value / (nonOrderReasons[0]?.value || 1)) * 100}%`, background: REASON_COLORS[i % REASON_COLORS.length] }} />
                      </div>
                    </div>
                    <span className="text-[10px] text-outline shrink-0">{fmt(r.count)} claims</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </SectionCard>
  );
}

// ── Unsettled Orders ──────────────────────────────────────────────────────────
function UnsettledOrders({ unsettled, mp }) {
  const rows = useMemo(() => {
    if (!unsettled?.length) return [];
    const mp2 = mp === 'all' ? null : mp;
    return mp2 ? unsettled.filter(r => matchesMarketplace(r.marketplace, mp2)) : unsettled;
  }, [unsettled, mp]);

  const totalVal = rows.reduce((s, r) => s + +r.value, 0);
  const totalCnt = rows.reduce((s, r) => s + +r.count, 0);

  return (
    <SectionCard
      title="Unsettled Orders"
      sub="Orders shipped but not yet reflected in any settlement report"
    >
      {rows.length === 0 ? (
        <div className="py-6 text-center text-emerald-500 text-sm font-medium">All orders settled</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-center">
              <p className="text-[10px] font-semibold text-amber-500 uppercase tracking-wider mb-1">Pending Value</p>
              <p className="text-xl font-bold text-amber-700">{fmtK(totalVal)}</p>
            </div>
            <div className="rounded-xl bg-surface-container-low border border-border p-3 text-center">
              <p className="text-[10px] font-semibold text-outline uppercase tracking-wider mb-1">Order Count</p>
              <p className="text-financial-md font-semibold text-ink tabular-nums">{fmt(totalCnt)}</p>
            </div>
          </div>
          <div className="space-y-2">
            {rows.map((r, i) => {
              const dot = MP_DOT[r.marketplace] || '#6366f1';
              const cycledays = MP_CYCLE[r.marketplace] || 10;
              return (
                <div key={i} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-surface-container-low">
                  <span className="h-3 w-3 rounded-full shrink-0" style={{ background: dot }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-ink capitalize">{r.marketplace}</span>
                      <span className="text-sm font-bold text-amber-700">{fmtK(r.value)}</span>
                    </div>
                    <p className="text-xs text-outline">{fmt(r.count)} orders · oldest: {fmtDateFull(r.oldest)}</p>
                    <p className="text-[10px] text-primary mt-0.5">
                      Expected settlement cycle: {cycledays} days
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </SectionCard>
  );
}

// ── Cash Flow Forecast ────────────────────────────────────────────────────────
function CashFlowForecast({ history, mp }) {
  const forecast = useMemo(() => {
    if (!history?.length) return [];
    const mp2 = mp === 'all' ? null : mp;
    const rows = (mp2 ? history.filter(r => matchesMarketplace(r.marketplace, mp2)) : history)
      .filter(r => r.date >= new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10));

    if (rows.length < 2) return [];

    // Calculate weekly average from last 8 weeks
    const recent = rows.slice(-56);
    const weeklyAvg = recent.reduce((s, r) => s + +r.inflow, 0) / (recent.length / 7 || 1);

    // Build last 8 weeks actual + 4 weeks forecast
    const weekly = {};
    for (const r of rows) {
      const d = new Date(r.date);
      const ws = new Date(d); ws.setDate(d.getDate() - d.getDay() + 1);
      const key = ws.toISOString().slice(0, 10);
      if (!weekly[key]) weekly[key] = { date: key, actual: 0, forecast: null };
      weekly[key].actual += +r.inflow;
    }
    const pastWeeks = Object.values(weekly).sort((a, b) => a.date.localeCompare(b.date)).slice(-8);
    const lastDate = new Date(pastWeeks[pastWeeks.length - 1]?.date || new Date());
    const forecastWeeks = Array.from({ length: 4 }, (_, i) => {
      const d = new Date(lastDate); d.setDate(d.getDate() + 7 * (i + 1));
      return { date: d.toISOString().slice(0, 10), actual: null, forecast: Math.round(weeklyAvg) };
    });

    return [...pastWeeks, ...forecastWeeks].map(r => ({
      ...r,
      label: fmtDate(r.date),
      isForecast: r.forecast !== null && r.actual === null,
    }));
  }, [history, mp]);

  return (
    <SectionCard title="Cash Flow Forecast" sub="Last 8 weeks actual + 4-week forward projection based on weekly avg">
      {forecast.length === 0 ? (
        <Empty msg="Not enough data for forecast" sub="Need at least 2 weeks of settlement data" />
      ) : (
        <>
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center gap-1.5 text-xs text-secondary">
              <span className="h-3 w-3 rounded bg-primary inline-block" /> Actual
            </div>
            <div className="flex items-center gap-1.5 text-xs text-secondary">
              <span className="h-3 w-3 rounded bg-primary-container inline-block border border-dashed border-primary" /> Forecast
            </div>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={forecast}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <YAxis tickFormatter={v => `₹${(v/1000).toFixed(0)}K`} tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <Tooltip
                formatter={(v, n) => [fmtK(v), n === 'actual' ? 'Actual Inflow' : 'Forecast']}
                contentStyle={{ borderRadius: 8, fontSize: 12 }}
              />
              <Bar dataKey="actual"   name="actual"   fill="#6366f1" radius={[3, 3, 0, 0]} />
              <Bar dataKey="forecast" name="forecast" fill="#c7d2fe" radius={[3, 3, 0, 0]} />
            </ComposedChart>
          </ResponsiveContainer>
        </>
      )}
    </SectionCard>
  );
}

// ── Recent NEFT Cycles ────────────────────────────────────────────────────────
function RecentNefts({ nefts, mp }) {
  const rows = useMemo(() => {
    if (!nefts?.length) return [];
    const mp2 = mp === 'all' ? null : mp;
    return mp2 ? nefts.filter(r => matchesMarketplace(r.marketplace, mp2)) : nefts;
  }, [nefts, mp]);

  return (
    <SectionCard title="Recent Settlement Cycles (NEFTs)" sub="Last 30 days — each row = one bank transfer">
      {rows.length === 0 ? <Empty msg="No settlement data" /> : (
        <div className="overflow-auto max-h-72">
          <table className="finance-table">
            <thead className="sticky top-0 bg-surface">
              <tr className="text-outline border-b border-border">
                <th className="text-left py-2 font-medium">NEFT ID</th>
                <th className="text-left py-2 font-medium">Date</th>
                {mp === 'all' && <th className="text-left py-2 font-medium">Platform</th>}
                <th className="text-right py-2 font-medium">Orders</th>
                <th className="text-right py-2 font-medium">Inflow</th>
                <th className="text-right py-2 font-medium">Net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {rows.map((r, i) => (
                <tr key={i} className="hover:bg-surface-container-low">
                  <td className="py-2 font-mono text-[10px] text-secondary max-w-[100px] truncate">{r.neft_id}</td>
                  <td className="py-2 text-secondary whitespace-nowrap">{fmtDateFull(r.date)}</td>
                  {mp === 'all' && <td className="py-2 text-outline capitalize">{r.marketplace}</td>}
                  <td className="py-2 text-right text-secondary">{fmt(r.items)}</td>
                  <td className="py-2 text-right text-emerald-600 font-medium">{fmtK(r.inflow)}</td>
                  <td className="py-2 text-right font-bold" style={{ color: +r.net >= 0 ? '#059669' : '#dc2626' }}>{fmtK(r.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function CashFlowPage() {
  const { filters, refreshKey } = useFilters();
  const mp = filters.marketplace || 'all';

  const { data, loading } = useFetch(
    () => fetchCashFlow(mp, refreshKey),
    [mp, refreshKey]
  );

  const { settled30, unsettledVal, spfTotal } = useMemo(() => {
    const hist = data?.settlementHistory || [];
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    const s30 = hist
      .filter(r => new Date(r.date) >= cutoff && matchesMp(r.marketplace, mp))
      .reduce((s, r) => s + +r.inflow, 0);

    const unsett = (data?.unsettled || [])
      .filter(r => matchesMp(r.marketplace, mp))
      .reduce((s, r) => s + +r.value, 0);

    const nonOrderSpf = (data?.spfTotals || [])
      .filter(r => matchesMp(r.marketplace, mp))
      .reduce((s, r) => s + +r.total_recovered, 0);

    const orderSpf = (data?.orderSpfSummary || [])
      .filter(r => matchesMp(r.marketplace, mp))
      .reduce((s, r) => s + +r.total_recovered, 0);

    const spfTotal = nonOrderSpf + orderSpf;
    return { settled30: s30, unsettledVal: unsett, spfTotal };
  }, [data, mp]);

  const unsettledCount = useMemo(() => {
    return (data?.unsettled || [])
      .filter(r => matchesMp(r.marketplace, mp))
      .reduce((s, r) => s + +r.count, 0);
  }, [data, mp]);

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <PageHeader
        title="Cash Flow & SPF Recovery"
        subtitle="Payment-month cash · uses FilterBar marketplace"
      >
      </PageHeader>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Settled (30 Days)"   value={fmtK(settled30)}    sub="cash received"          color="emerald" icon="✓" />
        <KpiCard label="Unsettled Value"      value={fmtK(unsettledVal)} sub={`${fmt(unsettledCount)} orders pending`} color={unsettledCount > 0 ? 'amber' : 'slate'} icon="⏳" alert={unsettledCount > 100} />
        <KpiCard
          label={mp === 'amazon' ? 'Reimbursements' : 'SPF Recovered'}
          value={fmtK(spfTotal)}
          sub={
            mp === 'amazon' ? 'safe-t & fba reimbursements' :
            mp?.startsWith('myntra') ? 'auto-spf & dispute claims' :
            mp === 'flipkart' ? 'seller protection fund' :
            'cross-portal claims & reimbursements'
          }
          color="violet"
          icon="🛡"
        />
        <KpiCard label="Settlement Cycle"     value={`${MP_CYCLE[mp] ?? 10}d`} sub={`avg for ${mp === 'all' ? 'all platforms' : mp}`} color="indigo" icon="🔁" />
      </div>

      {loading && (
        <div className="py-12 text-center text-outline text-sm animate-pulse">Loading cash flow data…</div>
      )}

      {!loading && (
        <>
          {/* Settlement timeline */}
          <SettlementTimeline history={data?.settlementHistory} mp={mp} />

          {/* Forecast + Unsettled side by side */}
          <div className="grid lg:grid-cols-2 gap-5">
            <CashFlowForecast history={data?.settlementHistory} mp={mp} />
            <UnsettledOrders  unsettled={data?.unsettled} mp={mp} />
          </div>

          {/* SPF + Recent NEFTs */}
          <div className="grid lg:grid-cols-2 gap-5">
            <SpfRecovery
              spfTotals={data?.spfTotals}
              spfReasons={data?.spfReasons}
              orderSpfSummary={data?.orderSpfSummary}
              orderSpfDetail={data?.orderSpfDetail}
              mp={mp}
            />
            <RecentNefts nefts={data?.recentNefts} mp={mp} />
          </div>
        </>
      )}
    </div>
  );
}
