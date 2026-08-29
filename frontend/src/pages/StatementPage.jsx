import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchMonthlyStatement, fetchRecoStatement, fetchSaleStatement,
} from '../api/client';
import ExportButton from '../components/ExportButton';
import { buildStatementExport } from '../utils/exportXlsx';
import useFetch from '../hooks/useFetch';
import { useFilters } from '../context/FilterContext';
import { currencyFull, currency } from '../utils/format';
import EmptyState from '../components/EmptyState';
import KPICard from '../components/KPICard';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Cell, ComposedChart, Line, Legend,
} from 'recharts';

const CAT_COLOR = {
  Revenue: '#6366f1', 'Return Cost': '#f43f5e',
  'Marketplace Fee': '#f59e0b', Tax: '#8b5cf6',
  Adjustment: '#0ea5e9', Total: '#10b981', Other: '#94a3b8',
};
const ttStyle = { borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 };

const STATEMENT_TABS = [
  ['sale', 'Sale Statement'],
  ['reco', 'Reconciliation'],
  ['summary', 'Monthly Summary'],
];

export default function StatementPage() {
  const [tab, setTab] = useState('sale');

  const { filters, refreshKey } = useFilters();
  const dep = [JSON.stringify(filters), refreshKey];
  const reportFilters = { ...filters, _refresh: refreshKey || undefined };

  // Fetch settlement statement tabs (P&L / Fee Leaks / SPF live on dedicated pages now)
  // Each report is expensive enough to defer until its tab is actually opened.
  // Once loaded, useFetch keeps the verified value visible during revalidation.
  const { data: saleData,      loading: ls, error: es, refetch: refreshSale } = useFetch(
    () => fetchSaleStatement(reportFilters), dep, { enabled: tab === 'sale' },
  );
  const { data: recoData,      loading: lr, error: er, refetch: refreshReco } = useFetch(
    () => fetchRecoStatement(reportFilters), dep, { enabled: tab === 'reco' },
  );
  const { data: statementData, loading: lm, error: em, refetch: refreshSummary } = useFetch(
    () => fetchMonthlyStatement(reportFilters), dep, { enabled: tab === 'summary' },
  );

  const loading = tab === 'sale' ? ls : tab === 'reco' ? lr : lm;
  const activeData = tab === 'sale' ? saleData : tab === 'reco' ? recoData : statementData;
  const activeError = tab === 'sale' ? es : tab === 'reco' ? er : em;
  const refresh = tab === 'sale' ? refreshSale : tab === 'reco' ? refreshReco : refreshSummary;
  const hasData = tab === 'sale'
    ? ((saleData?.saleData?.length || 0) > 0 || (saleData?.cashFlow?.length || 0) > 0)
    : tab === 'reco'
    ? (recoData?.months?.length || 0) > 0
    : (statementData?.months?.length || 0) > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-ink">Statement &amp; Reconciliation</h1>
          <p className="text-sm text-outline mt-0.5">
            Sale-based P&amp;L · Marketplace fee deductions · carry forward of pending orders
          </p>
        </div>
        <div className="flex items-center gap-3">
          {tab === 'summary' && statementData?.months?.length > 0 && (
            <ExportButton
              label="Export"
              buildExport={() => buildStatementExport(
                statementData.data, statementData.months,
                statementData.months[statementData.months.length - 1]
              )}
            />
          )}
          <div className="flex gap-1 bg-surface-container rounded-lg p-1" role="tablist">
            {STATEMENT_TABS.map(([v, l]) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={tab === v}
                onClick={() => setTab(v)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  tab === v
                    ? 'bg-surface text-[#902A4A] shadow-sm ring-1 ring-[#902A4A]/15'
                    : 'text-secondary hover:text-ink'
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Related tools — previously duplicated as Statement tabs */}
      <div className="flex flex-wrap gap-2 rounded-xl border border-stone-200 bg-surface px-4 py-3 text-xs text-stone-600">
        <span className="font-semibold text-stone-500 mr-1 self-center">Also see:</span>
        <Link to="/profit-loss" className="rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-1.5 font-semibold hover:border-[#902A4A]/30 hover:text-[#902A4A]">
          P&amp;L Summary
        </Link>
        <Link to="/rate-audit" className="rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-1.5 font-semibold hover:border-[#902A4A]/30 hover:text-[#902A4A]">
          Rate Audit (fee leaks)
        </Link>
        <Link to="/cash-flow" className="rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-1.5 font-semibold hover:border-[#902A4A]/30 hover:text-[#902A4A]">
          Cash Flow &amp; SPF
        </Link>
        <Link to="/return-tracking" className="rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-1.5 font-semibold hover:border-[#902A4A]/30 hover:text-[#902A4A]">
          Return Tracking
        </Link>
      </div>

      {activeError && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <span>Showing the last verified report. Refresh failed: {activeError}</span>
          <button type="button" onClick={refresh} className="shrink-0 rounded-md border border-amber-300 bg-surface px-2.5 py-1 font-semibold hover:bg-amber-100">Retry</button>
        </div>
      )}
      {loading && !activeData && (
        <div className="space-y-3 animate-pulse">
          {[1,2,3,4].map(i => <div key={i} className="h-14 bg-surface-container rounded-xl" />)}
        </div>
      )}
      {!loading && !hasData && (
        <EmptyState
          title="No settlement data found"
          marketplace={filters.marketplace || 'flipkart'}
          message="Upload a marketplace settlement file in Data Hub to build Statement & Reco."
        />
      )}
      {!loading && hasData && tab === 'sale'    && <SaleStatementView data={saleData} />}
      {!loading && hasData && tab === 'reco'    && <RecoView data={recoData} />}
      {!loading && hasData && tab === 'summary' && <SummaryView data={statementData} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 1: Sale Statement — order-date based
// ─────────────────────────────────────────────────────────────────────────────
function SaleStatementView({ data }) {
  const rows     = data?.saleData  || [];
  const cashFlow = data?.cashFlow  || [];
  const [expanded, setExpanded] = useState(null);
  const [showCash, setShowCash] = useState(false);

  const totals = useMemo(() => rows.reduce((a, r) => ({
    grossSale:    a.grossSale    + r.grossSale,
    returnAmount: a.returnAmount + r.returnAmount,
    totalMpFees:  a.totalMpFees  + r.totalMpFees,
    bankReceived: a.bankReceived + r.bankReceived,
    pendingNet:   a.pendingNet   + r.pendingExpectedNet,
    orderCount:   a.orderCount   + r.orderCount,
    pendingCount: a.pendingCount + r.pendingCount,
  }), { grossSale:0, returnAmount:0, totalMpFees:0, bankReceived:0, pendingNet:0, orderCount:0, pendingCount:0 }), [rows]);

  const settlePct = totals.grossSale > 0 ? (totals.bankReceived / totals.grossSale * 100).toFixed(1) : 0;

  if (!rows.length && !cashFlow.length) return (
    <div className="bg-surface-container-low rounded-xl border border-border p-10 text-center">
      <p className="text-secondary">No sale or settlement data found</p>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* KPIs */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <KPICard label="Total Gross Sale"   value={currency(totals.grossSale)}    color="indigo"  sub={`${totals.orderCount} orders`} />
        <KPICard label="Bank Received (MP)" value={currency(totals.bankReceived)} color="emerald" sub={`${settlePct}% of gross sale settled`} />
        <KPICard label="Carry Forward"      value={currency(totals.pendingNet)}   color="amber"   sub={`${totals.pendingCount} orders pending settlement`} />
        <KPICard label="MP Fees Deducted"   value={currency(totals.totalMpFees)}  color="rose"    sub={totals.grossSale > 0 ? `${(totals.totalMpFees/totals.grossSale*100).toFixed(1)}% of gross` : '—'} />
      </div>

      {/* Info note */}
      <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-xs text-blue-800">
        <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>
          This view starts from <strong>your sale data (order date)</strong>. Marketplace Settlement sheet = bank payment confirmation only —
          Marketplace settles 10–15 days after dispatch. Orders with no settlement entry are shown as <strong>Carry Forward</strong>
          (estimated net = invoice minus VB-calculated fees).
        </span>
      </div>

      {/* Sale-month table */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">Sale Statement — by Order Month</h3>
          <span className="text-xs text-outline">Click a row to expand fee detail (MP Deducted vs RC Calculated from Rate Card)</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-surface-container-low border-b border-border">
                {['Sale Month','Orders','Gross Sale','Returns','MP Fees','Bank Received','Carry Forward','Settled %'].map(h => (
                  <th key={h} className={`px-4 py-3 text-secondary font-medium whitespace-nowrap ${h==='Sale Month'||h==='Orders'?'text-left':'text-right'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const isOpen = expanded === r.saleMonth;
                return (
                  <>
                    <tr
                      key={r.saleMonth}
                      onClick={() => setExpanded(isOpen ? null : r.saleMonth)}
                      className={`border-b border-slate-50 cursor-pointer transition-colors ${isOpen ? 'bg-primary-container' : 'hover:bg-surface-container-low/80'}`}
                    >
                      <td className="px-4 py-3 font-semibold text-primary">
                        <span className="flex items-center gap-1.5">
                          <svg className={`w-3 h-3 text-outline transition-transform ${isOpen?'rotate-90':''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                          {r.saleMonth}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-secondary">{r.orderCount}</td>
                      <td className="px-4 py-3 text-right font-medium text-ink">{currencyFull(r.grossSale)}</td>
                      <td className="px-4 py-3 text-right text-rose-600">
                        {r.returnAmount > 0 ? <>−{currencyFull(r.returnAmount)}<div className="text-[10px] text-outline">{r.returnCount} orders</div></> : <span className="text-outline">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right text-amber-700">
                        {r.totalMpFees > 0 ? <>−{currencyFull(r.totalMpFees)}<div className="text-[10px] text-outline">{r.grossSale>0?(r.totalMpFees/r.grossSale*100).toFixed(1):0}%</div></> : <span className="text-outline">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="font-semibold text-emerald-700">{currencyFull(r.bankReceived)}</span>
                        <div className="text-[10px] text-outline">{r.settledCount} orders</div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {r.pendingCount > 0 ? (
                          <><span className="font-semibold text-amber-700">{currencyFull(r.pendingExpectedNet)}</span>
                          <div className="text-[10px] text-outline">{r.pendingCount} orders pending</div></>
                        ) : (
                          <span className="text-emerald-600 text-[11px] font-semibold">✓ Fully settled</span>
                        )}
                      </td>
                      <td className="px-4 py-3"><SettlePctBar pct={r.settlementPct} /></td>
                    </tr>
                    {isOpen && (
                      <tr key={r.saleMonth + '_d'}>
                        <td colSpan={8} className="px-0 py-0 bg-indigo-50/40 border-b border-primary">
                          <SaleFeeDetail row={r} />
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
              <tr className="bg-primary text-white font-bold border-t-2 border-primary">
                <td className="px-4 py-3 text-surface">TOTAL</td>
                <td className="px-4 py-3 text-right text-outline">{totals.orderCount}</td>
                <td className="px-4 py-3 text-right">{currencyFull(totals.grossSale)}</td>
                <td className="px-4 py-3 text-right text-rose-300">−{currencyFull(totals.returnAmount)}</td>
                <td className="px-4 py-3 text-right text-amber-300">−{currencyFull(totals.totalMpFees)}</td>
                <td className="px-4 py-3 text-right text-emerald-300">{currencyFull(totals.bankReceived)}</td>
                <td className="px-4 py-3 text-right text-amber-300">{currencyFull(totals.pendingNet)}</td>
                <td className="px-4 py-3 text-right text-outline">{settlePct}%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Cash flow collapsible */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <button
          onClick={() => setShowCash(v => !v)}
          className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-surface-container-low transition-colors"
        >
          <div>
            <p className="text-sm font-semibold text-ink text-left">Bank Receipts by Payment Month</p>
            <p className="text-xs text-outline mt-0.5 text-left">Actual cash received from Marketplace — grouped by payment date (not sale date)</p>
          </div>
          <svg className={`w-4 h-4 text-outline transition-transform ${showCash?'rotate-180':''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {showCash && cashFlow.length > 0 && (
          <div className="border-t border-border overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-surface-container-low border-b border-border">
                  {['Payment Month','Orders Settled','Cash In','Clawbacks','SPF','Storage','Ads','Total Received'].map(h => (
                    <th key={h} className={`px-4 py-2.5 text-secondary font-medium whitespace-nowrap ${h==='Payment Month'?'text-left':'text-right'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {cashFlow.map(c => (
                  <tr key={c.paymentMonth} className="hover:bg-surface-container-low/60">
                    <td className="px-4 py-2.5 font-medium text-ink">{c.paymentMonth}</td>
                    <td className="px-4 py-2.5 text-right text-secondary">{c.settledCount}</td>
                    <td className="px-4 py-2.5 text-right text-emerald-700 font-medium">{currencyFull(c.cashIn)}</td>
                    <td className="px-4 py-2.5 text-right text-rose-600">{c.cashOut > 0 ? `−${currencyFull(c.cashOut)}` : <span className="text-outline">—</span>}</td>
                    <td className="px-4 py-2.5 text-right text-sky-700">{c.spf ? currencyFull(c.spf) : <span className="text-outline">—</span>}</td>
                    <td className="px-4 py-2.5 text-right">{c.storage ? currencyFull(c.storage) : <span className="text-outline">—</span>}</td>
                    <td className="px-4 py-2.5 text-right">{c.ads ? currencyFull(c.ads) : <span className="text-outline">—</span>}</td>
                    <td className="px-4 py-2.5 text-right font-bold text-ink">{currencyFull(c.totalReceived)}</td>
                  </tr>
                ))}
                <tr className="bg-emerald-50 border-t-2 border-emerald-200 font-bold">
                  <td className="px-4 py-3 text-emerald-800" colSpan={2}>TOTAL CASH RECEIVED</td>
                  <td className="px-4 py-3 text-right text-emerald-800">{currencyFull(cashFlow.reduce((s,c)=>s+c.cashIn,0))}</td>
                  <td className="px-4 py-3 text-right text-rose-700">−{currencyFull(cashFlow.reduce((s,c)=>s+c.cashOut,0))}</td>
                  <td className="px-4 py-3 text-right text-sky-700">{currencyFull(cashFlow.reduce((s,c)=>s+c.spf,0))}</td>
                  <td className="px-4 py-3 text-right">{currencyFull(cashFlow.reduce((s,c)=>s+c.storage,0))}</td>
                  <td className="px-4 py-3 text-right">{currencyFull(cashFlow.reduce((s,c)=>s+c.ads,0))}</td>
                  <td className="px-4 py-3 text-right text-emerald-800">{currencyFull(cashFlow.reduce((s,c)=>s+c.totalReceived,0))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {showCash && cashFlow.length === 0 && (
          <div className="border-t border-border p-6 text-center text-sm text-outline">
            No payment date data in settlement sheet
          </div>
        )}
      </div>
    </div>
  );
}

// Expandable fee detail row inside sale statement
function SaleFeeDetail({ row }) {
  const f = row.fees;
  const pctOf = v => row.grossSale > 0 ? (v / row.grossSale * 100).toFixed(1) : '0.0';

  const FEE_LINES = [
    { label: 'Commission',        fk: f.mpCommission,       vb: f.vbCommission,     rc: f.rcCommission     },
    { label: 'Fixed Fee',          fk: f.mpFixedFee,          vb: f.vbFixedFee,       rc: f.rcFixedFee       },
    { label: 'Collection Fee',     fk: f.mpCollectionFee,     vb: f.vbCollectionFee, rc: f.rcCollectionFee  },
    { label: 'Pick & Pack Fee',     fk: f.mpPickPackFee,        vb: f.vbPickPackFee,   rc: f.rcPickPackFee    },
    { label: 'Shipping Fee',       fk: f.mpShippingFee,        vb: f.vbShippingFee,   rc: null               },
    { label: 'Reverse Shipping',   fk: f.mpReverseShipping,    vb: null,              rc: f.rcReverseShipping},
    { label: 'Franchise Fee',      fk: f.mpFranchiseFee,       vb: null,              rc: f.rcFranchiseFee   },
    { label: 'Other MP Fees',      fk: f.mpOtherFee,           vb: null,              rc: null               },
    { label: 'TCS',                fk: f.mpTcs,                 vb: null,              rc: null               },
    { label: 'TDS',                fk: f.mpTds,                 vb: null,              rc: null               },
    { label: 'GST on MP Fees',     fk: f.mpGst,                vb: null,              rc: null               },
  ].filter(l => l.fk > 0.005 || (l.vb !== null && l.vb > 0.005) || (l.rc !== null && l.rc > 0.005));

  return (
    <div className="px-6 py-4">
      <div className="max-w-3xl">
        <p className="text-[11px] font-bold text-primary uppercase tracking-widest mb-2">
          Fee Breakdown — {row.saleMonth} &nbsp;·&nbsp;
          <span className="font-normal text-secondary normal-case">MP Deducted = actual from settlement sheet · RC Calculated = from your Rate Card config</span>
        </p>
        <table className="w-full text-xs border border-border rounded-lg overflow-hidden">
          <thead>
            <tr className="bg-surface-container">
              <th className="text-left px-4 py-2 text-secondary font-medium">Fee Line</th>
              <th className="text-right px-4 py-2 text-rose-700 font-semibold">MP Deducted<br/><span className="font-normal text-[9px] text-rose-400">Actual from settlement</span></th>
              <th className="text-right px-4 py-2 text-primary font-semibold">RC Calculated<br/><span className="font-normal text-[9px] text-indigo-400">Our rate card</span></th>
              <th className="text-right px-4 py-2 text-emerald-700 font-semibold">Variance<br/><span className="font-normal text-[9px] text-emerald-400">MP − RC</span></th>
              <th className="text-right px-4 py-2 text-secondary font-medium">% of Sale</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-surface">
            <tr className="bg-indigo-50/40">
              <td className="px-4 py-2 font-semibold text-ink">Gross Sale ({row.orderCount} orders)</td>
              <td className="px-4 py-2 text-right text-primary font-semibold">{currencyFull(row.grossSale)}</td>
              <td className="px-4 py-2 text-right text-primary">{currencyFull(row.grossSale)}</td>
              <td className="px-4 py-2 text-right text-outline">—</td>
              <td className="px-4 py-2 text-right text-secondary">100%</td>
            </tr>
            {row.returnAmount > 0 && (
              <tr className="bg-rose-50/30">
                <td className="px-4 py-2 text-rose-700 pl-7">↓ Returns / RTOs ({row.returnCount})</td>
                <td className="px-4 py-2 text-right text-rose-600 font-medium">−{currencyFull(row.returnAmount)}</td>
                <td className="px-4 py-2 text-right text-outline">—</td>
                <td className="px-4 py-2 text-right text-outline">—</td>
                <td className="px-4 py-2 text-right text-rose-500">−{pctOf(row.returnAmount)}%</td>
              </tr>
            )}
            <tr className="bg-amber-50">
              <td colSpan={5} className="px-4 py-1.5 text-[10px] font-bold text-amber-700 uppercase tracking-widest">
                Deductions (settled orders only — {row.settledCount} of {row.orderCount})
              </td>
            </tr>
            {FEE_LINES.map(l => {
              const variance = l.rc !== null ? l.fk - l.rc : (l.vb !== null ? l.fk - l.vb : null);
              return (
                <tr key={l.label} className="hover:bg-surface-container-low/60">
                  <td className="px-4 py-2 text-ink pl-7">{l.label}</td>
                  <td className="px-4 py-2 text-right font-semibold text-rose-700">{l.fk > 0 ? currencyFull(l.fk) : <span className="text-outline">—</span>}</td>
                  <td className="px-4 py-2 text-right">
                    {l.rc !== null && l.rc > 0.005 ? (
                      <span className="font-medium text-primary">{currencyFull(l.rc)}</span>
                    ) : l.vb !== null && l.vb > 0.005 ? (
                      <span className="font-medium text-indigo-400 text-[10px]">{currencyFull(l.vb)} <span className="text-outline">(VB)</span></span>
                    ) : <span className="text-outline text-[10px]">N/A</span>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {variance !== null ? <VarPill v={variance} /> : <span className="text-outline">—</span>}
                  </td>
                  <td className="px-4 py-2 text-right text-secondary">{l.fk > 0 ? `−${pctOf(l.fk)}%` : '—'}</td>
                </tr>
              );
            })}
            <tr className="bg-primary text-white font-bold">
              <td className="px-4 py-2.5">Total MP Fees</td>
              <td className="px-4 py-2.5 text-right text-rose-300">{currencyFull(row.totalMpFees)}</td>
              <td className="px-4 py-2.5 text-right text-indigo-200">{currencyFull(row.totalRcFees)}</td>
              <td className="px-4 py-2.5 text-right"><VarPill v={row.feeVariance} light /></td>
              <td className="px-4 py-2.5 text-right text-outline">{pctOf(row.totalMpFees)}%</td>
            </tr>
            <tr className="bg-emerald-50 border-t-2 border-emerald-200">
              <td className="px-4 py-2.5 font-bold text-emerald-800">Bank Received (settled {row.settledCount} orders)</td>
              <td className="px-4 py-2.5 text-right font-bold text-emerald-800">{currencyFull(row.bankReceived)}</td>
              <td className="px-4 py-2.5 text-right text-outline text-[10px]">Actual MP bank</td>
              <td className="px-4 py-2.5 text-right text-outline">—</td>
              <td className="px-4 py-2.5 text-right text-emerald-700 font-semibold">{pctOf(row.bankReceived)}%</td>
            </tr>
            {row.pendingCount > 0 && (
              <tr className="bg-amber-50 border-t border-amber-200">
                <td className="px-4 py-2.5 font-bold text-amber-800">Carry Forward ({row.pendingCount} orders pending)</td>
                <td className="px-4 py-2.5 text-right font-bold text-amber-800">
                  {currencyFull(row.pendingInvoice)}
                  <div className="text-[10px] font-normal text-secondary">Gross invoice</div>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className="font-semibold text-amber-700">{currencyFull(row.pendingExpectedNet)}</span>
                  <div className="text-[10px] text-secondary">Est. net (after ~{currencyFull(row.pendingVbFees)} VB fees)</div>
                </td>
                <td className="px-4 py-2.5 text-right text-outline">—</td>
                <td className="px-4 py-2.5 text-right text-amber-700">{pctOf(row.pendingExpectedNet)}%</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 2: Reconciliation — payment-date based, MP vs VB fees
// ─────────────────────────────────────────────────────────────────────────────
function RecoView({ data }) {
  const months  = data?.months || [];
  const allData = data?.data   || [];
  const [selMonth, setSelMonth] = useState(months[months.length - 1] || null);
  const md = allData.find(d => d.month === selMonth);

  const totalPending      = allData.reduce((s,d) => s + (d.pending?.amount || 0), 0);
  const allMonthsPending  = allData.filter(d => d.pending?.count > 0).sort((a,b) => a.month.localeCompare(b.month));

  if (!md) return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        {months.map(m => (
          <button key={m} onClick={() => setSelMonth(m)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${m===selMonth?'bg-primary text-white':'bg-surface border border-border text-secondary hover:bg-surface-container-low'}`}
          >{m}</button>
        ))}
      </div>
      <p className="text-outline text-sm">Select a month above</p>
    </div>
  );

  const mpSale = md.mpSale;
  const pctOf  = v => mpSale > 0 ? (v / mpSale * 100).toFixed(1) : '—';

  return (
    <div className="space-y-6">
      <div className="flex gap-2 flex-wrap">
        {months.map(m => (
          <button key={m} onClick={() => setSelMonth(m)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${m===selMonth?'bg-primary text-white shadow-sm':'bg-surface border border-border text-secondary hover:bg-surface-container-low'}`}
          >{m}</button>
        ))}
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <KPICard label="MP Sale Amount"      value={currency(mpSale)}          color="indigo"  sub={`${md.settledCount} orders settled`} />
        <KPICard label="Net Settled (Paid)"  value={currency(md.netSettled)}   color="emerald" sub={`${pctOf(md.netSettled)}% of sale`} />
        <KPICard label="Total MP Deductions" value={currency(md.totalMpFees)}  color="rose"    sub={`${pctOf(md.totalMpFees)}% of sale`} />
        <KPICard label="Fee Variance (MP−VB)"
          value={currency(Math.abs(md.feeVariance))}
          color="amber"
          sub={md.feeVariance > 0.01 ? 'MP overcharged vs RC' : md.feeVariance < -0.01 ? 'MP undercharged vs RC' : 'Matched ✓'} />
      </div>

      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-start justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-sm font-semibold text-ink">Reconciliation — {selMonth} (by Payment Date)</h3>
            <p className="text-xs text-outline mt-0.5">MP Deducted = actual from settlement sheet · RC Calculated = from Rate Card config · Variance = MP minus RC</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-3 text-[10px] text-secondary">
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-rose-400" />MP overcharged</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />MP undercharged</span>
            </div>
            <button
              onClick={() => {
                const rows = [
                  ['Fee Line', 'MP Deducted', 'RC Calculated', 'Variance', '% of Sale'],
                  ['Gross Sale', md.mpSale, md.vbSale, '', '100%'],
                  md.mpReturns > 0 ? ['Returns / RTOs', -md.mpReturns, '', '', ''] : null,
                  ...(md.lines || []).map(l => [
                    l.label,
                    l.fk,
                    l.vb ?? 'N/A',
                    l.variance ?? '',
                    md.mpSale > 0 ? `${(l.fk / md.mpSale * 100).toFixed(1)}%` : '',
                  ]),
                  ['TOTAL MP FEES', md.totalMpFees, md.totalVbFees, md.feeVariance, `${md.mpSale > 0 ? (md.totalMpFees/md.mpSale*100).toFixed(1) : 0}%`],
                ].filter(Boolean);
                const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
                a.download = `reco-${selMonth}.csv`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
              }}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-lg hover:bg-emerald-100 font-semibold transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download CSV
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-surface-container-low border-b border-border">
                <th className="text-left px-4 py-3 text-secondary font-medium w-48">Line Item</th>
                <th className="text-right px-4 py-3 text-rose-700 font-semibold">MP Deducted</th>
                <th className="text-right px-4 py-3 text-primary font-semibold">RC Calculated</th>
                <th className="text-right px-4 py-3 text-secondary font-medium">Variance</th>
                <th className="text-right px-4 py-3 text-secondary font-medium">% of Sale</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {/* Gross Sale */}
              <tr className="bg-indigo-50/50">
                <td className="px-4 py-3 font-semibold text-ink">Gross Sale Amount</td>
                <td className="px-4 py-3 text-right font-semibold text-primary">{currencyFull(mpSale)}</td>
                <td className="px-4 py-3 text-right font-medium text-primary">
                  {currencyFull(md.vbSale)}
                  <div className="text-[10px] text-outline">{md.vbOrderCount} orders matched</div>
                </td>
                <td className="px-4 py-3 text-right"><VarPill v={mpSale - md.vbSale} invert={false} /></td>
                <td className="px-4 py-3 text-right text-secondary">100%</td>
              </tr>
              {/* Returns */}
              {md.mpReturns > 0.01 && (
                <tr className="bg-rose-50/40">
                  <td className="px-4 py-3 text-rose-700 font-medium pl-8">↓ Returns / Reversals</td>
                  <td className="px-4 py-3 text-right text-rose-600 font-semibold">−{currencyFull(md.mpReturns)}</td>
                  <td className="px-4 py-3 text-right text-outline">—</td>
                  <td className="px-4 py-3 text-right text-outline">—</td>
                  <td className="px-4 py-3 text-right text-rose-500">−{pctOf(md.mpReturns)}%</td>
                </tr>
              )}
              {/* Fee lines */}
              <tr className="bg-amber-50">
                <td colSpan={5} className="px-4 py-1.5 text-[10px] font-bold text-amber-700 uppercase tracking-widest">Marketplace Fees</td>
              </tr>
              {md.lines.filter(l => l.cat === 'fee').map(l => (
                <tr key={l.key} className="hover:bg-surface-container-low/60">
                  <td className="px-4 py-2.5 text-ink pl-8">{l.label}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-rose-700">{currencyFull(l.fk)}</td>
                  <td className="px-4 py-2.5 text-right">{l.vb !== null ? <span className="font-medium text-primary">{currencyFull(l.vb)}</span> : <span className="text-outline text-[10px]">N/A</span>}</td>
                  <td className="px-4 py-2.5 text-right">{l.variance !== null ? <VarPill v={l.variance} /> : <span className="text-outline">—</span>}</td>
                  <td className="px-4 py-2.5 text-right text-secondary">−{pctOf(l.fk)}%</td>
                </tr>
              ))}
              {/* Tax lines */}
              {md.lines.some(l => l.cat === 'tax') && (
                <tr className="bg-violet-50">
                  <td colSpan={5} className="px-4 py-1.5 text-[10px] font-bold text-violet-700 uppercase tracking-widest">Tax</td>
                </tr>
              )}
              {md.lines.filter(l => l.cat === 'tax').map(l => (
                <tr key={l.key} className="hover:bg-surface-container-low/60">
                  <td className="px-4 py-2.5 text-ink pl-8">{l.label}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-violet-700">{currencyFull(l.fk)}</td>
                  <td className="px-4 py-2.5 text-right text-outline text-[10px]">N/A</td>
                  <td className="px-4 py-2.5 text-right text-outline">—</td>
                  <td className="px-4 py-2.5 text-right text-secondary">−{pctOf(l.fk)}%</td>
                </tr>
              ))}
              {/* Adjustments */}
              {(md.spfTotal !== 0 || md.storTotal !== 0 || md.adsTotal !== 0) && (
                <tr className="bg-sky-50">
                  <td colSpan={5} className="px-4 py-1.5 text-[10px] font-bold text-sky-700 uppercase tracking-widest">Other Adjustments</td>
                </tr>
              )}
              {md.spfTotal !== 0 && (
                <tr className="hover:bg-surface-container-low/60">
                  <td className="px-4 py-2.5 text-ink pl-8">SPF / Penalty Claims</td>
                  <td className={`px-4 py-2.5 text-right font-semibold ${md.spfTotal>=0?'text-emerald-700':'text-rose-700'}`}>{md.spfTotal>=0?'+':''}{currencyFull(md.spfTotal)}</td>
                  <td className="px-4 py-2.5 text-right text-outline">—</td>
                  <td className="px-4 py-2.5 text-right text-outline">—</td>
                  <td className="px-4 py-2.5 text-right text-secondary">{md.spfTotal>=0?'+':'-'}{pctOf(Math.abs(md.spfTotal))}%</td>
                </tr>
              )}
              {md.storTotal !== 0 && (
                <tr className="hover:bg-surface-container-low/60">
                  <td className="px-4 py-2.5 text-ink pl-8">Storage / Recall Fee</td>
                  <td className={`px-4 py-2.5 text-right font-semibold ${md.storTotal>=0?'text-emerald-700':'text-rose-700'}`}>{currencyFull(md.storTotal)}</td>
                  <td className="px-4 py-2.5 text-right text-outline">—</td>
                  <td className="px-4 py-2.5 text-right text-outline">—</td>
                  <td className="px-4 py-2.5 text-right text-secondary">{pctOf(Math.abs(md.storTotal))}%</td>
                </tr>
              )}
              {md.adsTotal !== 0 && (
                <tr className="hover:bg-surface-container-low/60">
                  <td className="px-4 py-2.5 text-ink pl-8">Marketplace Ads Spend</td>
                  <td className={`px-4 py-2.5 text-right font-semibold ${md.adsTotal>=0?'text-emerald-700':'text-rose-700'}`}>{currencyFull(md.adsTotal)}</td>
                  <td className="px-4 py-2.5 text-right text-outline">—</td>
                  <td className="px-4 py-2.5 text-right text-outline">—</td>
                  <td className="px-4 py-2.5 text-right text-secondary">{pctOf(Math.abs(md.adsTotal))}%</td>
                </tr>
              )}
              {/* Totals */}
              <tr className="bg-primary text-white">
                <td className="px-4 py-3 font-bold">Total Deductions</td>
                <td className="px-4 py-3 text-right font-bold text-rose-300">{currencyFull(md.totalMpFees)}</td>
                <td className="px-4 py-3 text-right font-bold text-indigo-200">{currencyFull(md.totalVbFees)}</td>
                <td className="px-4 py-3 text-right"><VarPill v={md.feeVariance} light /></td>
                <td className="px-4 py-3 text-right text-outline">{pctOf(md.totalMpFees)}%</td>
              </tr>
              <tr className="bg-emerald-50 border-t-2 border-emerald-200">
                <td className="px-4 py-3 font-bold text-emerald-800">NET SETTLED (Paid by MP)</td>
                <td className="px-4 py-3 text-right font-bold text-emerald-800 text-sm">{currencyFull(md.netSettled)}</td>
                <td className="px-4 py-3 text-right">
                  <span className="font-semibold text-emerald-700">{currencyFull(md.vbExpectedNet)}</span>
                  <div className="text-[10px] text-outline">VB expected</div>
                </td>
                <td className="px-4 py-3 text-right"><VarPill v={md.netSettled - md.vbExpectedNet} invert={false} /></td>
                <td className="px-4 py-3 text-right font-semibold text-emerald-700">{pctOf(md.netSettled)}%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Pending panel */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className={`rounded-xl border p-5 ${md.pending ? 'bg-amber-50 border-amber-200' : 'bg-surface-container-low border-border'}`}>
          <p className="text-[11px] font-bold uppercase tracking-wide text-amber-700 mb-1">Carry Forward — {selMonth}</p>
          <p className="text-2xl font-bold text-amber-900">{md.pending ? currency(md.pending.amount) : '₹0'}</p>
          <p className="text-xs text-amber-700 mt-0.5">{md.pending ? `${md.pending.count} orders placed in this month not yet settled` : 'All orders fully settled'}</p>
        </div>
        <div className="bg-surface rounded-xl border border-border p-5">
          <p className="text-sm font-semibold text-ink mb-3">All Months — Carry Forward Summary</p>
          {allMonthsPending.length === 0 ? (
            <p className="text-sm text-outline text-center py-4">All orders settled</p>
          ) : (
            <div className="space-y-1.5 max-h-40 overflow-y-auto">
              {allMonthsPending.map(d => (
                <div key={d.month} className="flex items-center justify-between text-xs py-1 border-b border-slate-50 last:border-0">
                  <span className="font-medium text-ink">{d.month}</span>
                  <div className="text-right">
                    <span className="font-bold text-amber-700">{currencyFull(d.pending.amount)}</span>
                    <span className="text-outline ml-2">{d.pending.count} orders</span>
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between text-xs py-2 border-t-2 border-amber-200 mt-1">
                <span className="font-bold text-ink">Total Pending</span>
                <span className="font-bold text-amber-700">{currencyFull(totalPending)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 3: Monthly Summary — existing payment-date grouped P&L
// ─────────────────────────────────────────────────────────────────────────────
function SummaryView({ data }) {
  const [selectedMonth, setSelectedMonth] = useState(null);
  const months  = data?.months || [];
  const allData = data?.data   || [];
  const activeMonth = selectedMonth || months[months.length - 1] || null;
  const monthItems  = allData.filter(d => d.month === activeMonth && d.description !== 'NET SETTLED');
  const totalRow    = allData.find(d => d.month === activeMonth && d.description === 'NET SETTLED');
  const saleItem    = monthItems.find(d => d.description.toLowerCase().includes('sale amount'));
  const saleAmt     = saleItem?.net || 0;
  const activeIdx   = months.indexOf(activeMonth);
  const prevMonth   = activeIdx > 0 ? months[activeIdx - 1] : null;
  const prevItems   = prevMonth ? allData.filter(d => d.month === prevMonth && d.description !== 'NET SETTLED') : [];
  const prevMap     = Object.fromEntries(prevItems.map(d => [d.description, d]));
  const deductionItems = monthItems
    .filter(d => d.category !== 'Revenue' && d.category !== 'Total' && d.net !== 0)
    .sort((a,b) => Math.abs(b.net) - Math.abs(a.net));
  const waterfallItems = [
    ...(saleItem ? [{ description: 'Sale Amount', pct: 100, net: saleItem.net, category: 'Revenue' }] : []),
    ...deductionItems.map(d => ({ ...d, pct: saleAmt > 0 ? +((d.net / saleAmt) * 100).toFixed(2) : 0 })),
    ...(totalRow ? [{ description: 'Net Settlement', pct: totalRow.pct, net: totalRow.net, category: 'Total' }] : []),
  ];
  const trendMap = {};
  allData.forEach(d => {
    if (!trendMap[d.month]) trendMap[d.month] = { month: d.month, saleAmt: 0, netSettled: 0, deductions: 0, refunds: 0 };
    if (d.description.toLowerCase().includes('sale amount')) trendMap[d.month].saleAmt = d.net;
    if (d.description === 'NET SETTLED') trendMap[d.month].netSettled = d.net;
    if (d.category === 'Return Cost') trendMap[d.month].refunds += Math.abs(d.net);
    if (['Marketplace Fee','Tax'].includes(d.category)) trendMap[d.month].deductions += Math.abs(d.net);
  });
  const trendData = Object.values(trendMap).sort((a,b) => a.month.localeCompare(b.month));

  return (
    <div className="space-y-6">
      <div className="flex gap-2 flex-wrap">
        {months.map(m => (
          <button key={m} onClick={() => setSelectedMonth(m)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${m===activeMonth?'bg-primary text-white shadow-sm':'bg-surface border border-border text-secondary hover:bg-surface-container-low'}`}
          >{m}</button>
        ))}
      </div>
      {activeMonth && (
        <>
          <div className="text-xs text-outline">Period: <span className="font-medium text-secondary">{allData.find(d=>d.month===activeMonth)?.period}</span></div>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            <KPICard label="Sale Amount (MP)"   value={currency(saleAmt)} color="indigo" sub="100%" />
            <KPICard label="Total Deductions" value={currency(monthItems.filter(d=>['Marketplace Fee','Tax'].includes(d.category)).reduce((s,d)=>s+Math.abs(d.net),0))} color="rose" sub="—" />
            <KPICard label="Refunds / Returns" value={currency(monthItems.filter(d=>d.category==='Return Cost').reduce((s,d)=>s+Math.abs(d.net),0))} color="amber" sub="—" />
            <KPICard label="Net Settlement"    value={currency(totalRow?.net||0)} color="emerald" sub={totalRow?`${(+totalRow.pct||0).toFixed(1)}% of sale`:'—'} />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="bg-surface rounded-xl border border-border p-5">
              <h3 className="text-sm font-semibold text-ink mb-3">% Allocation of Sale Amount</h3>
              <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
                {waterfallItems.map((item,i) => {
                  const w   = Math.min(Math.abs(item.pct||0), 100);
                  const pos = (item.net||0) >= 0;
                  const col = CAT_COLOR[item.category] || '#94a3b8';
                  return (
                    <div key={i}>
                      <div className="flex justify-between text-[11px] mb-1">
                        <span className="text-secondary font-medium truncate max-w-[200px]">{item.description}</span>
                        <div className="flex items-center gap-3 ml-2 shrink-0">
                          <span className={`font-bold ${pos?'text-emerald-700':'text-rose-600'}`}>{pos?'+':''}{(item.pct||0).toFixed(1)}%</span>
                          <span className="text-outline w-28 text-right">{currencyFull(item.net||0)}</span>
                        </div>
                      </div>
                      <div className="h-5 bg-surface-container rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{width:`${Math.max(w,1)}%`,backgroundColor:col,opacity:pos?0.9:0.7}} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="bg-surface rounded-xl border border-border p-5">
              <h3 className="text-sm font-semibold text-ink mb-3">Deduction by Category</h3>
              {deductionItems.length === 0
                ? <div className="h-72 flex items-center justify-center text-outline text-sm">No data</div>
                : <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={deductionItems.slice(0,12)} layout="vertical" margin={{top:4,right:16,bottom:4,left:0}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                      <XAxis type="number" tickFormatter={v=>currency(Math.abs(v))} tick={{fontSize:10,fill:'#94a3b8'}} axisLine={false} tickLine={false} />
                      <YAxis type="category" dataKey="description" tick={{fontSize:10,fill:'#64748b'}} axisLine={false} tickLine={false} width={140} />
                      <Tooltip formatter={v=>[currencyFull(Math.abs(v)),'Amount']} contentStyle={ttStyle} />
                      <Bar dataKey="net" radius={[0,4,4,0]}>
                        {deductionItems.slice(0,12).map((d,i) => <Cell key={i} fill={CAT_COLOR[d.category]||'#94a3b8'} opacity={0.85} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
              }
            </div>
          </div>

          <div className="bg-surface rounded-xl border border-border overflow-hidden">
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-sm font-semibold text-ink">Line-wise Statement — {activeMonth}</h3>
              <p className="text-xs text-outline mt-0.5">Grouped by MP payment date</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-surface-container-low border-b border-border">
                    {['Description','Category','Credits','Debits','Net','% of Sale'].map(h => (
                      <th key={h} className="text-left px-4 py-3 text-secondary font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {monthItems.map((item,i) => {
                    const prev    = prevMap[item.description];
                    const pctDiff = prev !== undefined ? item.pct - prev.pct : null;
                    const isHot   = pctDiff !== null && Math.abs(pctDiff) > 1;
                    const isUp    = pctDiff > 0;
                    return (
                      <tr key={i} className={`hover:bg-surface-container-low/60 ${isHot?(isUp?'bg-emerald-50/50':'bg-rose-50/50'):item.description==='Sale Amount'?'bg-indigo-50/40':''}`}>
                        <td className="px-4 py-2.5 font-medium text-ink">{item.description}</td>
                        <td className="px-4 py-2.5">
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{backgroundColor:(CAT_COLOR[item.category]||'#94a3b8')+'20',color:CAT_COLOR[item.category]||'#94a3b8'}}>
                            {item.category}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-emerald-700 font-medium">{item.credits>0?currencyFull(item.credits):<span className="text-outline">—</span>}</td>
                        <td className="px-4 py-2.5 text-rose-600 font-medium">{item.debits>0?currencyFull(item.debits):<span className="text-outline">—</span>}</td>
                        <td className="px-4 py-2.5"><span className={`font-bold ${item.net>=0?'text-emerald-700':'text-rose-600'}`}>{item.net>=0?'+':''}{currencyFull(item.net)}</span></td>
                        <td className="px-4 py-2.5"><PctBar value={item.pct} net={item.net} /></td>
                      </tr>
                    );
                  })}
                  {totalRow && (
                    <tr className="bg-emerald-50 border-t-2 border-emerald-200">
                      <td className="px-4 py-3 font-bold text-emerald-800" colSpan={4}>Net Settlement</td>
                      <td className="px-4 py-3 font-bold text-emerald-800 text-sm">{currencyFull(totalRow.net)}</td>
                      <td className="px-4 py-3 font-bold text-emerald-700">{(+totalRow.pct||0).toFixed(1)}%</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {trendData.length > 1 && (
        <div className="bg-surface rounded-xl border border-border p-5">
          <h3 className="text-sm font-semibold text-ink mb-1">Month-over-Month Trend</h3>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={trendData} margin={{top:4,right:8,bottom:4,left:0}}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f8fafc" />
              <XAxis dataKey="month" tick={{fontSize:11,fill:'#94a3b8'}} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v=>currency(v)} tick={{fontSize:10,fill:'#94a3b8'}} axisLine={false} tickLine={false} width={68} />
              <Tooltip formatter={(v,n)=>[currencyFull(v),n]} contentStyle={ttStyle} />
              <Legend wrapperStyle={{fontSize:11,paddingTop:8}} />
              <Bar dataKey="saleAmt"    name="Sale Amount"   fill="#6366f1" opacity={0.25} radius={[3,3,0,0]} maxBarSize={40} />
              <Bar dataKey="deductions" name="MP Fees"       fill="#f59e0b" opacity={0.8}  radius={[3,3,0,0]} maxBarSize={40} />
              <Bar dataKey="refunds"    name="Refunds"       fill="#f43f5e" opacity={0.75} radius={[3,3,0,0]} maxBarSize={40} />
              <Line type="monotone" dataKey="netSettled" name="Net Settlement" stroke="#10b981" strokeWidth={2.5} dot={{r:4,fill:'#10b981'}} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────
function VarPill({ v, invert = true, light = false }) {
  if (v === null || v === undefined) return <span className="text-outline">—</span>;
  const abs = Math.abs(v);
  if (abs < 0.01) return <span className={`text-[11px] font-semibold ${light?'text-emerald-300':'text-emerald-600'}`}>₹0 ✓</span>;
  const bad  = invert ? v > 0 : v < 0;
  const sign = v > 0 ? '+' : '−';
  const col  = bad ? (light?'text-rose-300':'text-rose-600') : (light?'text-emerald-300':'text-emerald-600');
  return (
    <span className={`text-[11px] font-semibold ${col}`}>
      {sign}₹{abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
      {bad && !light && <span className="ml-0.5 text-[9px]">⚠</span>}
    </span>
  );
}

function SettlePctBar({ pct }) {
  const p = Math.min(+pct || 0, 100);
  const color = p >= 95 ? '#10b981' : p >= 60 ? '#f59e0b' : '#f43f5e';
  return (
    <div className="w-20">
      <div className="text-[10px] font-semibold mb-0.5" style={{ color }}>{p}%</div>
      <div className="h-1.5 bg-surface-container-high rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width:`${p}%`, backgroundColor:color }} />
      </div>
    </div>
  );
}

function PctBar({ value, net }) {
  const w = Math.min(Math.abs(value||0), 100);
  const pos = net >= 0;
  return (
    <div className="flex items-center gap-2 min-w-[90px]">
      <div className="flex-1 bg-surface-container rounded-full h-1.5 overflow-hidden">
        <div className="h-full rounded-full" style={{width:`${Math.max(w,1)}%`,backgroundColor:pos?'#10b981':'#f43f5e'}} />
      </div>
      <span className={`text-[10px] font-semibold w-10 text-right ${pos?'text-emerald-700':'text-rose-600'}`}>{pos?'+':''}{(value||0).toFixed(1)}%</span>
    </div>
  );
}
