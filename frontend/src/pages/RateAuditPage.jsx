import { useState } from 'react';
import { useFilters } from '../context/FilterContext';
import useFetch from '../hooks/useFetch';
import useResettingPage from '../hooks/useResettingPage';
import { fetchRateCardReconcile, fetchRateCardFeeSummary, fetchFeeIntelligence, fetchRcEntryReco, fetchRcEntryOrders, updateDisputeStatus, fetchMonthlyDetailedReport } from '../api/client';
import { currencyFull, num } from '../utils/format';
import ExportButton from '../components/ExportButton';
import { useAnimatedDisplayValue } from '../hooks/useAnimatedDisplayValue';
import { exportXlsx, buildDetailedReportExport } from '../utils/exportXlsx';
import OrderDetailDrawer, { OrderIdCell } from '../components/OrderDetailDrawer';

const STATUS_COLORS = {
  ok:            'bg-emerald-100 text-emerald-700 border-emerald-200',
  overcharged:   'bg-rose-100 text-rose-700 border-rose-200',
  undercharged:  'bg-amber-100 text-amber-700 border-amber-200',
  no_settlement: 'bg-surface-container text-secondary border-border',
};
const STATUS_LABELS = {
  ok: 'Match', overcharged: 'Overcharged', undercharged: 'Undercharged', no_settlement: 'No Settlement',
};

// Colour palette per fee group
const GROUP_COLORS = {
  mp:  ['#6366f1','#8b5cf6','#a78bfa','#c4b5fd','#7c3aed','#5b21b6','#4f46e5','#818cf8','#60a5fa','#93c5fd','#38bdf8'],
  tax: ['#f59e0b','#fbbf24','#fcd34d'],
};

export function FlipkartFeeAudit({ embedded = false }) {
  const { filters, refreshKey } = useFilters();
  // The audit SQL is the Flipkart rate-card engine. Do not let the global
  // marketplace filter accidentally make this page calculate another market.
  const auditFilters = {
    ...filters,
    ...(embedded ? { marketplace: 'flipkart' } : {}),
    _refresh: refreshKey || undefined,
  };
  const dep = [JSON.stringify(auditFilters), refreshKey];
  const [tab, setTab]           = useState('breakdown');
  const [statusFilter, setStatus] = useState('all');
  const [page, setPage]         = useResettingPage(dep[0]);
  const [selectedId, setSelectedId] = useState(null);
  const PAGE_SIZE = 50;

  // Entry Analysis state — marketplace selector for RC entry reco
  const [rcMp, setRcMp]       = useState('flipkart');
  const [rcSa, setRcSa]       = useState('default');
  const [rcDrill, setRcDrill] = useState(null); // { feeType, rcId }

  const { data: feeData, loading: fl, error: fe, refetch: refreshFee } = useFetch(
    () => fetchRateCardFeeSummary(auditFilters), dep, { enabled: tab === 'breakdown' }
  );
  const { data: auditData, loading: al, error: ae, refetch: refreshAudit } = useFetch(
    () => fetchRateCardReconcile(auditFilters), dep, { enabled: tab === 'issues' }
  );
  const { data: intelData, loading: il, error: ie, refetch: refreshIntel } = useFetch(
    () => fetchFeeIntelligence(refreshKey), [refreshKey], { enabled: tab === 'intel' }
  );
  const { data: rcEntryData, loading: rel, error: ree, refetch: refreshEntry } = useFetch(
    () => fetchRcEntryReco(rcMp, rcSa, refreshKey),
    [rcMp, rcSa, refreshKey], { enabled: tab === 'entry' && !rcDrill }
  );

  const activeError = tab === 'breakdown' ? fe : tab === 'issues' ? ae : tab === 'intel' ? ie : (rcDrill ? null : ree);
  const refreshActive = tab === 'breakdown' ? refreshFee : tab === 'issues' ? refreshAudit : tab === 'intel' ? refreshIntel : refreshEntry;

  const s        = auditData?.summary || {};
  const allIssues = auditData?.issues || [];
  const filtered  = statusFilter === 'all' ? allIssues : allIssues.filter(r => r.status === statusFilter);
  const paged     = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        {!embedded && <div>
          <h1 className="text-xl font-bold text-ink">Rate Card Audit</h1>
          <p className="text-sm text-outline mt-0.5">
            Settlement fee breakdown · compare FK deductions vs rate card
          </p>
        </div>}
        <div className="flex items-center gap-2">
          <ExportButton 
            label="Detailed Monthly Report"
            disabled={!auditFilters.month}
            buildExport={async () => {
              const res = await fetchMonthlyDetailedReport(auditFilters.month, auditFilters.marketplace || 'flipkart');
              return buildDetailedReportExport(res.data, auditFilters.month, auditFilters.marketplace || 'flipkart');
            }}
          />
          <ExportButton
            label="Export Issues"
            disabled={allIssues.length === 0}
            buildExport={() => buildAuditExport(allIssues, s)}
          />
          <div className="flex gap-1 bg-surface-container rounded-lg p-1">
            {[
              ['breakdown', 'Fee Breakdown'],
              ['issues',    'Order Issues'],
              ['intel',     `⚡ Intelligence${intelData?.alerts?.length > 0 ? ` (${intelData.alerts.length})` : ''}`],
              ['entry',     '🔬 Entry Analysis'],
            ].map(([v, l]) => (
              <button key={v} onClick={() => setTab(v)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  tab === v ? 'bg-surface text-ink shadow-sm' :
                  v === 'intel' && intelData?.alerts?.length > 0 ? 'text-rose-600 hover:text-rose-700 font-semibold' :
                  'text-secondary hover:text-ink'
                }`}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      {activeError && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span>Showing the last verified report. Refresh failed: {activeError}</span>
          <button type="button" onClick={refreshActive} className="rounded-md border border-amber-300 bg-surface px-2.5 py-1 font-bold text-amber-900 hover:bg-amber-100">Retry</button>
        </div>
      )}

      {/* ── Tab 1: Fee Breakdown ─────────────────────────────────────────────── */}
      {tab === 'breakdown' && (
        fl && !feeData ? <SkeletonBreakdown /> :
        fe && !feeData ? <ErrBox msg={fe} /> :
        (feeData?.fees?.length || feeData?.grossSales > 0) ? <FeeSummaryView data={feeData} /> :
        <div className="p-10 text-center text-outline">No settlement data for selected filters</div>
      )}

      {/* ── Tab 2: Order Issues (existing) ───────────────────────────────────── */}
      {tab === 'issues' && (
        ae && !auditData ? <ErrBox msg={ae} /> : <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            <AuditKPI label="Orders Checked"     value={num(s.checkedOrders)}   sub={`of ${num(s.totalOrders)} total`} color="slate" />
            <AuditKPI label="Discrepancies"      value={num(s.issueCount)}       sub={`${s.issuePct || 0}% of checked`} color={s.issueCount > 0 ? 'rose' : 'emerald'} />
            <AuditKPI label="Total Overcharged"  value={`₹${(s.totalOvercharged  || 0).toFixed(0)}`} sub={`${s.overchargedCount  || 0} orders`} color="rose" />
            <AuditKPI label="Total Undercharged" value={`₹${(s.totalUndercharged || 0).toFixed(0)}`} sub={`${s.underchargedCount || 0} orders`} color="amber" />
          </div>

          {/* Status filter */}
          <div className="flex gap-2 flex-wrap">
            {[
              ['all',         `All (${allIssues.length})`],
              ['overcharged', `Overcharged (${s.overchargedCount || 0})`],
              ['undercharged',`Undercharged (${s.underchargedCount || 0})`],
            ].map(([k, label]) => (
              <button key={k} onClick={() => { setStatus(k); setPage(1); }}
                className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors ${
                  statusFilter === k ? 'bg-primary text-white' : 'bg-surface border border-border text-secondary hover:bg-surface-container-low'
                }`}>{label}</button>
            ))}
          </div>

          {/* Issues table */}
          <div className="bg-surface rounded-xl border border-border overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-ink">Fee Discrepancies</h3>
                <p className="text-xs text-outline mt-0.5">{filtered.length} orders · largest discrepancy first</p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  className="px-3 py-1.5 text-xs rounded-lg border border-border text-secondary disabled:opacity-40 hover:bg-surface-container-low">← Prev</button>
                <span className="text-xs text-secondary">Page {page} / {Math.ceil(filtered.length / PAGE_SIZE) || 1}</span>
                <button onClick={() => setPage(p => p + 1)} disabled={page * PAGE_SIZE >= filtered.length}
                  className="px-3 py-1.5 text-xs rounded-lg border border-border text-secondary disabled:opacity-40 hover:bg-surface-container-low">Next →</button>
              </div>
            </div>
            {al && !auditData ? (
              <div className="p-8 text-center text-outline text-sm">Analysing orders against rate card…</div>
            ) : allIssues.length === 0 ? (
              <div className="p-12 text-center">
                <div className="text-4xl mb-3">✅</div>
                <p className="text-secondary font-semibold">No discrepancies found</p>
                <p className="text-outline text-sm mt-1">All settled orders match the rate card within tolerance</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gradient-to-r from-slate-800 to-slate-700 text-white">
                      {['Order ID','Date','Category','Price','Status','Fee Type','Expected','FK Charged','Difference'].map(h => (
                        <th key={h} className="text-left px-4 py-3 font-semibold whitespace-nowrap text-[11px] opacity-90">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {(paged || []).map(order =>
                      (order.issues || []).map((issue, j) => (
                        <tr key={`${order.orderItemId}-${j}`} className={`hover:bg-surface-container-low/60 ${issue.overcharged ? 'bg-rose-50/30' : 'bg-amber-50/30'}`}>
                          {j === 0 && (
                            <>
                              <td className="px-4 py-2.5" rowSpan={order.issues.length}>
                                <OrderIdCell id={order.orderItemId} onOpen={setSelectedId} />
                              </td>
                              <td className="px-4 py-2.5 text-secondary whitespace-nowrap font-mono text-[10px]" rowSpan={order.issues.length}>{order.orderDate ? String(order.orderDate).slice(0,10) : '—'}</td>
                              <td className="px-4 py-2.5 text-secondary" rowSpan={order.issues.length}>{order.category}</td>
                              <td className="px-4 py-2.5 font-semibold text-ink" rowSpan={order.issues.length}>{currencyFull(order.price)}</td>
                              <td className="px-4 py-2.5" rowSpan={order.issues.length}>
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${STATUS_COLORS[order.status]}`}>
                                  {STATUS_LABELS[order.status]}
                                </span>
                              </td>
                            </>
                          )}
                          <td className="px-4 py-2.5 font-medium text-ink">{issue.fee}</td>
                          <td className="px-4 py-2.5 text-secondary">{currencyFull(issue.expected)}</td>
                          <td className="px-4 py-2.5 text-secondary">{currencyFull(issue.actual)}</td>
                          <td className="px-4 py-2.5">
                            <span className={`font-bold ${issue.overcharged ? 'text-rose-700' : 'text-amber-700'}`}>
                              {issue.overcharged ? '↑ +' : '↓ −'}{currencyFull(Math.abs(issue.diff))}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Tab 3: Fee Intelligence ──────────────────────────────────────────── */}
      {tab === 'intel' && (
        il && !intelData ? <SkeletonBreakdown /> :
        ie && !intelData ? <ErrBox msg={ie} /> :
        intelData ? <FeeIntelligenceView data={intelData} /> :
        <div className="p-10 text-center text-outline">No intelligence data available</div>
      )}

      {/* ── Tab 4: RC Entry Analysis ─────────────────────────────────────────── */}
      {tab === 'entry' && (
        rcDrill
          ? <RcEntryOrdersView
              feeType={rcDrill.feeType}
              rcId={rcDrill.rcId}
              marketplace={rcMp}
              sellerAccount={rcSa}
              onBack={() => setRcDrill(null)}
            />
          : <RcEntryRecoView
              data={rcEntryData}
              loading={rel}
              error={ree}
              marketplace={rcMp}
              sellerAccount={rcSa}
              onMpChange={setRcMp}
              onSaChange={setRcSa}
              onDrill={(feeType, rcId) => setRcDrill({ feeType, rcId })}
            />
      )}
    </div>

    <OrderDetailDrawer orderItemId={selectedId} onClose={() => setSelectedId(null)} />
    </>
  );
}

export default function RateAuditPage() {
  return <FlipkartFeeAudit />;
}

// ─── Fee Summary View (Tab 1) ─────────────────────────────────────────────────
function FeeSummaryView({ data }) {
  const {
    grossSales = 0,
    netSettlement = 0,
    saleOrders = 0,
    returnOrders = 0,
    totalDeducted = 0,
    deductionPct = 0,
    fees = [],
    mpFees = [],
    taxFees = [],
    nonOrderFees = [],
    spfFees = [],
  } = data || {};

  const totalMp       = (mpFees || []).reduce((s, f) => s + (f.amount || 0), 0);
  const totalTax      = (taxFees || []).reduce((s, f) => s + (f.amount || 0), 0);
  const totalNonOrder = (nonOrderFees || []).reduce((s, f) => s + (f.amount || 0), 0);
  const totalSpf      = (spfFees || []).reduce((s, f) => s + (f.amount || 0), 0);

  return (
    <div className="space-y-6">
      {/* Top KPIs */}
      <div className="grid grid-cols-2 xl:grid-cols-5 gap-4">
        <KPIBox label="Gross Sales"       value={currencyFull(grossSales)}      sub={`${saleOrders} sale orders`}   color="indigo" />
        <KPIBox label="Total Deducted"    value={currencyFull(totalDeducted)}   sub={`${deductionPct}% of sales`}  color="rose" />
        <KPIBox label="MP Fees"           value={currencyFull(totalMp)}         sub={`${grossSales>0?((totalMp/grossSales)*100).toFixed(1):0}% of sales`} color="purple" />
        <KPIBox label="Taxes / Statutory" value={currencyFull(totalTax)}        sub={`${grossSales>0?((totalTax/grossSales)*100).toFixed(1):0}% of sales`} color="amber" />
        <KPIBox label="Net Settlement"    value={currencyFull(netSettlement)}   sub={`${returnOrders} return cycles`} color={netSettlement >= 0 ? 'emerald' : 'rose'} />
      </div>

      {/* Composition Bar */}
      {fees?.length > 0 && (
        <div className="bg-surface rounded-xl border border-border p-5">
          <h3 className="text-sm font-semibold text-ink mb-1">Deduction Composition</h3>
          <p className="text-xs text-outline mb-4">How FK splits the total amount deducted from your settlements</p>
          <div className="flex h-8 rounded-lg overflow-hidden gap-px">
            {(fees || []).map((f, i) => {
              const w = totalDeducted > 0 ? (f.amount / totalDeducted) * 100 : 0;
              if (w < 0.5) return null;
              const colors = GROUP_COLORS[f.group] || ['#94a3b8'];
              return (
                <div key={f.key || i} title={`${f.label}: ₹${f.amount?.toFixed?.(0) || f.amount} (${f.pctOfSales}% of sales)`}
                  className="h-full transition-all cursor-default"
                  style={{ width: `${w}%`, backgroundColor: colors[i % colors.length] }}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 mt-3">
            {(fees || []).map((f, i) => {
              const colors = GROUP_COLORS[f.group] || ['#94a3b8'];
              return (
                <span key={f.key || i} className="flex items-center gap-1.5 text-[11px] text-secondary">
                  <span className="w-2.5 h-2.5 rounded-sm inline-block shrink-0" style={{ backgroundColor: colors[i % colors.length] }} />
                  {f.label}
                  <span className="text-outline font-mono">{f.pctOfSales}%</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Marketplace Fees table */}
      <FeeTable title="Marketplace Fees" icon="🏪" fees={mpFees} totalSales={grossSales} />

      {/* Tax / Statutory table */}
      <FeeTable title="Tax & Statutory Deductions" icon="🏛️" fees={taxFees} totalSales={grossSales} showExpected />

      {/* Non-order deductions */}
      {nonOrderFees && nonOrderFees.length > 0 && (
        <NonOrderFeesTable
          fees={nonOrderFees}
          spfFees={spfFees}
          spfClaimRows={data.spfClaimRows || []}
          totalNonOrder={totalNonOrder}
          totalSpf={totalSpf}
          grossSales={grossSales}
        />
      )}
    </div>
  );
}

// ─── Non-Order Deductions Table ───────────────────────────────────────────────
function NonOrderFeesTable({ fees, spfFees, spfClaimRows, totalNonOrder, totalSpf, grossSales }) {
  const [showSpf, setShowSpf] = useState(false);
  const grandTotal = totalNonOrder + totalSpf;

  const NON_ORDER_META = {
    storage:    { label: 'Storage / Recall',  icon: '📦', color: 'text-ink',  note: 'Monthly storage & recall charges' },
    ads:        { label: 'FK Ads Spend',       icon: '📢', color: 'text-purple-700', note: 'Flipkart marketplace ad charges' },
    googleAds:  { label: 'Google Ads Spend',   icon: '🔍', color: 'text-blue-700',   note: 'Google PPC charges via FK' },
    spf:        { label: 'SPF Claims (orders)',icon: '🛡️', color: 'text-rose-700',   note: 'Per-order protection fund in settlement' },
  };

  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <span className="text-base">⚡</span>
          <div>
            <h3 className="text-sm font-semibold text-ink">Non-Order Deductions</h3>
            <p className="text-xs text-outline">
              NEFT-level charges not tied to individual orders — Total:&nbsp;
              <span className="font-semibold text-rose-700">{currencyFull(grandTotal)}</span>
              &nbsp;·&nbsp;{grossSales > 0 ? ((grandTotal / grossSales) * 100).toFixed(2) : 0}% of gross sales
            </p>
          </div>
        </div>
        {spfClaimRows && spfClaimRows.length > 0 && (
          <button
            onClick={() => setShowSpf(v => !v)}
            className="text-xs px-3 py-1.5 bg-rose-50 text-rose-700 border border-rose-200 rounded-lg hover:bg-rose-100"
          >
            {showSpf ? 'Hide' : 'View'} SPF Claims ({spfClaimRows.length})
          </button>
        )}
      </div>

      {/* Summary rows */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-surface-container-low border-b border-border">
              <th className="text-left px-5 py-3 text-secondary font-semibold min-w-[220px]">Deduction Type</th>
              <th className="text-right px-4 py-3 text-secondary font-semibold">Amount</th>
              <th className="text-right px-4 py-3 text-secondary font-semibold">% of Gross Sales</th>
              <th className="px-4 py-3 text-secondary font-semibold min-w-[180px]">Bar</th>
              <th className="px-4 py-3 text-secondary font-semibold">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {(fees || []).map(f => {
              const meta = NON_ORDER_META[f.key] || {};
              const barW = grandTotal > 0 ? (f.amount / grandTotal) * 100 : 0;
              return (
                <tr key={f.key} className="hover:bg-surface-container-low/50 transition-colors">
                  <td className="px-5 py-3">
                    <span className="mr-2">{meta.icon || '•'}</span>
                    <span className={`font-semibold ${meta.color || 'text-ink'}`}>
                      {meta.label || f.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-rose-700">{currencyFull(f.amount)}</td>
                  <td className="px-4 py-3 text-right text-secondary font-mono">
                    {grossSales > 0 ? ((f.amount / grossSales) * 100).toFixed(3) : 0}%
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-2 bg-surface-container rounded-full overflow-hidden w-full">
                      <div className="h-full rounded-full bg-orange-400 transition-all"
                        style={{ width: `${Math.max(barW, 1)}%` }} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-outline text-[11px] italic">
                    {meta.note || ''}
                  </td>
                </tr>
              );
            })}

            {/* SPF (per-order) in settlement */}
            {totalSpf > 0 && (() => {
              const barW = grandTotal > 0 ? (totalSpf / grandTotal) * 100 : 0;
              const meta = NON_ORDER_META['spf'];
              return (
                <tr className="hover:bg-surface-container-low/50 bg-rose-50/30 transition-colors">
                  <td className="px-5 py-3">
                    <span className="mr-2">{meta.icon}</span>
                    <span className={`font-semibold ${meta.color}`}>{meta.label}</span>
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-rose-700">{currencyFull(totalSpf)}</td>
                  <td className="px-4 py-3 text-right text-secondary font-mono">
                    {grossSales > 0 ? ((totalSpf / grossSales) * 100).toFixed(3) : 0}%
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-2 bg-surface-container rounded-full overflow-hidden w-full">
                      <div className="h-full rounded-full bg-rose-400 transition-all"
                        style={{ width: `${Math.max(barW, 1)}%` }} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-outline text-[11px] italic">{meta.note}</td>
                </tr>
              );
            })()}

            {/* Grand total row */}
            <tr className="bg-primary text-white">
              <td className="px-5 py-3 font-bold">Total Non-Order Deductions</td>
              <td className="px-4 py-3 text-right font-bold text-rose-300">{currencyFull(grandTotal)}</td>
              <td className="px-4 py-3 text-right font-mono text-outline">
                {grossSales > 0 ? ((grandTotal / grossSales) * 100).toFixed(2) : 0}%
              </td>
              <td className="px-4 py-3" />
              <td className="px-4 py-3" />
            </tr>
          </tbody>
        </table>
      </div>

      {/* SPF Claims detail table */}
      {showSpf && spfClaimRows && spfClaimRows.length > 0 && (
        <div className="border-t border-border px-5 py-4">
          <h4 className="text-xs font-semibold text-secondary mb-3 flex items-center gap-2">
            <span>🛡️</span> SPF Claim Detail ({spfClaimRows.length} entries shown)
          </h4>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-rose-50 border-b border-rose-100">
                  <th className="text-left px-4 py-2 text-rose-700 font-semibold">NEFT / UTR</th>
                  <th className="text-left px-4 py-2 text-rose-700 font-semibold">Date</th>
                  <th className="text-left px-4 py-2 text-rose-700 font-semibold">Claim ID</th>
                  <th className="text-left px-4 py-2 text-rose-700 font-semibold">Protection Reason</th>
                  <th className="text-left px-4 py-2 text-rose-700 font-semibold">SKU / FSN</th>
                  <th className="text-right px-4 py-2 text-rose-700 font-semibold">Claim Amount</th>
                  <th className="text-right px-4 py-2 text-rose-700 font-semibold">Selling Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rose-50">
                {spfClaimRows.map((row, i) => (
                  <tr key={i} className="hover:bg-rose-50/40">
                    <td className="px-4 py-2 font-mono text-secondary text-[10px]">{row.neft_id || '—'}</td>
                    <td className="px-4 py-2 text-secondary whitespace-nowrap">{row.payment_date ? String(row.payment_date).slice(0,10) : '—'}</td>
                    <td className="px-4 py-2 text-secondary font-mono text-[10px]">{row.claim_id || '—'}</td>
                    <td className="px-4 py-2 text-secondary">{row.protection_reason || '—'}</td>
                    <td className="px-4 py-2 text-secondary text-[10px]">
                      {row.seller_sku && <span className="block">{row.seller_sku}</span>}
                      {row.fsn && <span className="block text-outline">{row.fsn}</span>}
                    </td>
                    <td className="px-4 py-2 text-right font-bold text-rose-700">{currencyFull(Math.abs(+(row.settlement_value || 0)))}</td>
                    <td className="px-4 py-2 text-right text-secondary">{row.selling_price ? currencyFull(+row.selling_price) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function FeeTable({ title, icon, fees, totalSales, showExpected }) {
  if (!fees || fees.length === 0) return null;
  const total = fees.reduce((s, f) => s + f.amount, 0);

  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <span className="text-base">{icon}</span>
        <div>
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <p className="text-xs text-outline">
            Total: <span className="font-semibold text-rose-700">{currencyFull(total)}</span>
            &nbsp;·&nbsp; {totalSales > 0 ? ((total/totalSales)*100).toFixed(2) : '0'}% of gross sales
          </p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-surface-container-low border-b border-border">
              <th className="text-left px-5 py-3 text-secondary font-semibold min-w-[200px]">Fee Type</th>
              <th className="text-right px-4 py-3 text-secondary font-semibold">FK Deducted</th>
              <th className="text-right px-4 py-3 text-secondary font-semibold">% of Sales</th>
              <th className="text-right px-4 py-3 text-secondary font-semibold">% of Deductions</th>
              <th className="px-4 py-3 text-secondary font-semibold min-w-[180px]">Breakdown Bar</th>
              {showExpected && <>
                <th className="text-right px-4 py-3 text-secondary font-semibold">Statutory Expected</th>
                <th className="text-right px-4 py-3 text-secondary font-semibold">Variance</th>
              </>}
              {!showExpected && <th className="px-4 py-3 text-secondary font-semibold min-w-[120px]">Note</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {(fees || []).map(f => {
              const barW = total > 0 ? (f.amount / total) * 100 : 0;
              return (
                <tr key={f.key} className="hover:bg-surface-container-low/50 transition-colors">
                  <td className="px-5 py-3">
                    <span className="font-semibold text-ink">{f.label}</span>
                    {f.statutory && (
                      <span className="ml-2 text-[10px] text-outline bg-surface-container px-1.5 py-0.5 rounded">{f.statutory}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-rose-700">
                    {currencyFull(f.amount)}
                  </td>
                  <td className="px-4 py-3 text-right text-secondary font-mono">
                    {f.pctOfSales}%
                  </td>
                  <td className="px-4 py-3 text-right text-secondary font-mono">
                    {f.pctOfTotal || (total > 0 ? ((f.amount/total)*100).toFixed(1) : 0)}%
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-2 bg-surface-container rounded-full overflow-hidden w-full">
                      <div className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${Math.max(barW, 1)}%` }} />
                    </div>
                  </td>
                  {showExpected && (
                    <>
                      <td className="px-4 py-3 text-right text-secondary">
                        {f.expected != null ? currencyFull(f.expected) : <span className="text-outline">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {f.variance != null ? (
                          <span className={`font-bold ${Math.abs(f.variance) < 2 ? 'text-emerald-600' : f.overcharged ? 'text-rose-600' : 'text-amber-600'}`}>
                            {f.variance >= 0 ? '+' : ''}₹{Math.abs(f.variance).toFixed(2)}
                            {Math.abs(f.variance) < 2 && <span className="ml-1 text-[10px] font-normal">✓</span>}
                          </span>
                        ) : <span className="text-outline">—</span>}
                      </td>
                    </>
                  )}
                  {!showExpected && (
                    <td className="px-4 py-3 text-outline text-[11px] italic">
                      {f.key === 'commission'   ? 'Per rate card %' :
                       f.key === 'fixedFee'     ? 'Fixed per fulfilment type' :
                       f.key === 'collectionFee'? 'Prepaid/postpaid rate' :
                       f.key === 'pickPackFee'  ? 'Per order handling' :
                       f.key === 'shippingFee'  ? 'Forward shipping' :
                       f.key === 'reverseShipping' ? 'Return logistics' :
                       'Per FK terms'}
                    </td>
                  )}
                </tr>
              );
            })}
            {/* Total row */}
            <tr className="bg-primary text-white">
              <td className="px-5 py-3 font-bold">Total {fees[0]?.group === 'tax' ? 'Tax' : 'MP Fees'}</td>
              <td className="px-4 py-3 text-right font-bold text-rose-300">{currencyFull(total)}</td>
              <td className="px-4 py-3 text-right font-mono text-outline">
                {totalSales > 0 ? ((total/totalSales)*100).toFixed(2) : 0}%
              </td>
              <td className="px-4 py-3 text-right text-outline">100%</td>
              <td className="px-4 py-3" />
              {showExpected && <><td className="px-4 py-3" /><td className="px-4 py-3" /></>}
              {!showExpected && <td className="px-4 py-3" />}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function KPIBox({ label, value, sub, color }) {
  const c = {
    indigo:  { bg: 'bg-primary-container',  text: 'text-primary',  val: 'text-primary' },
    rose:    { bg: 'bg-rose-50',    text: 'text-rose-600',    val: 'text-rose-900' },
    purple:  { bg: 'bg-purple-50',  text: 'text-purple-600',  val: 'text-purple-900' },
    amber:   { bg: 'bg-amber-50',   text: 'text-amber-600',   val: 'text-amber-900' },
    emerald: { bg: 'bg-emerald-50', text: 'text-emerald-600', val: 'text-emerald-900' },
  }[color] || { bg: 'bg-surface-container-low', text: 'text-secondary', val: 'text-ink' };
  const animatedValue = useAnimatedDisplayValue(value);
  return (
    <div className={`${c.bg} rounded-xl p-4 border border-white shadow-sm`}>
      <p className={`text-[11px] font-semibold uppercase tracking-wide ${c.text}`}>{label}</p>
      <p className={`text-xl font-bold mt-1 tabular-nums ${c.val}`}>{animatedValue}</p>
      {sub && <p className={`text-xs mt-0.5 ${c.text}`}>{sub}</p>}
    </div>
  );
}

function AuditKPI({ label, value, sub, color }) {
  return <KPIBox label={label} value={value} sub={sub} color={color} />;
}

function SkeletonBreakdown() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="grid grid-cols-5 gap-4">{Array(5).fill(0).map((_,i)=><div key={i} className="h-20 bg-surface-container rounded-xl"/>)}</div>
      <div className="h-32 bg-surface-container rounded-xl" />
      <div className="h-64 bg-surface-container rounded-xl" />
      <div className="h-48 bg-surface-container rounded-xl" />
    </div>
  );
}

function ErrBox({ msg }) {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-6">
      <p className="text-rose-700 font-semibold">Failed to load</p>
      <p className="text-rose-600 text-xs mt-1 font-mono">{msg}</p>
    </div>
  );
}

// ─── Fee Intelligence View (Tab 3) ───────────────────────────────────────────
function FeeIntelligenceView({ data }) {
  const { orderFees = [], nonOrderFees = [], alerts = [] } = data || {};

  const newAlerts  = alerts.filter(a => a.severity === 'new');
  const upAlerts   = alerts.filter(a => a.severity === 'up');
  const downAlerts = alerts.filter(a => a.severity === 'down');

  // Only show fee rows that have some activity (current or previous)
  const activeOrderFees = orderFees.filter(f => f.curr > 0 || f.prev > 0);

  return (
    <div className="space-y-6">
      {/* Period banner */}
      <div className="flex items-center gap-3 bg-surface-container-low border border-border rounded-xl px-5 py-3">
        <svg className="w-4 h-4 text-secondary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <p className="text-sm text-secondary">
          Comparing <strong className="text-ink">Last 30 days</strong> vs <strong className="text-ink">Previous 30 days</strong> — auto-detects new or significantly changed deductions
        </p>
      </div>

      {/* Alert cards */}
      {alerts.length === 0 ? (
        <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-4">
          <span className="text-2xl">✅</span>
          <div>
            <p className="font-semibold text-emerald-800 text-sm">All clear — no unusual fee changes detected</p>
            <p className="text-xs text-emerald-700 mt-0.5">No new fee types appeared and no significant increases vs the previous 30-day period</p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <h3 className="text-sm font-bold text-ink flex items-center gap-2">
            <span className="text-base">🚨</span>
            {alerts.length} Alert{alerts.length !== 1 ? 's' : ''} Requiring Attention
          </h3>

          {/* NEW FEE alerts */}
          {newAlerts.map(a => (
            <div key={a.key} className="bg-rose-50 border border-rose-300 rounded-xl p-4 flex items-start gap-4">
              <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-rose-500 flex items-center justify-center text-white text-base">⚡</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs px-2 py-0.5 bg-rose-500 text-white rounded-full font-bold">NEW FEE DETECTED</span>
                  <span className="font-bold text-rose-900 text-sm">{a.label}</span>
                  {a.source === 'order' && a.rcType && (
                    <span className="text-[10px] bg-primary-container text-primary px-1.5 py-0.5 rounded font-medium">Configure in Rate Card → {a.rcType.replace('_', ' ')}</span>
                  )}
                </div>
                <p className="text-xs text-rose-800 mt-1.5">
                  This deduction appeared for the <strong>first time</strong> in the last 30 days.&nbsp;
                  Amount: <strong>{currencyFull(a.curr)}</strong>
                  {a.nCurr > 0 && ` across ${a.nCurr} order${a.nCurr !== 1 ? 's' : ''}`}
                </p>
                <p className="text-xs text-rose-700 mt-1 bg-rose-100 rounded px-2 py-1 inline-block">
                  💡 Action: Check Flipkart's latest rate card announcement. If this is a new fee type, add it to Rate Card Config.
                </p>
              </div>
            </div>
          ))}

          {/* SIGNIFICANT INCREASE alerts */}
          {upAlerts.map(a => (
            <div key={a.key} className="bg-amber-50 border border-amber-300 rounded-xl p-4 flex items-start gap-4">
              <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-amber-500 flex items-center justify-center text-white text-base">📈</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs px-2 py-0.5 bg-amber-500 text-white rounded-full font-bold">SIGNIFICANT INCREASE</span>
                  <span className="font-bold text-amber-900 text-sm">{a.label}</span>
                </div>
                <div className="flex items-center gap-4 mt-2 text-xs text-amber-800">
                  <span>Previous: <strong>{currencyFull(a.prev)}</strong></span>
                  <span className="text-amber-400">→</span>
                  <span>Current: <strong>{currencyFull(a.curr)}</strong></span>
                  <span className="font-bold text-amber-700 bg-amber-200 px-2 py-0.5 rounded">+{a.changePct}%</span>
                </div>
                <p className="text-xs text-amber-700 mt-1 bg-amber-100 rounded px-2 py-1 inline-block">
                  💡 Action: Check if FK announced a rate change. Verify your rate card config matches the latest FK rate card.
                </p>
              </div>
            </div>
          ))}

          {/* Significant DECREASE alerts */}
          {downAlerts.map(a => (
            <div key={a.key} className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex items-start gap-4">
              <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-blue-500 flex items-center justify-center text-white text-base">📉</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs px-2 py-0.5 bg-blue-500 text-white rounded-full font-bold">SIGNIFICANT DECREASE</span>
                  <span className="font-bold text-blue-900 text-sm">{a.label}</span>
                </div>
                <div className="flex items-center gap-4 mt-2 text-xs text-blue-800">
                  <span>Previous: <strong>{currencyFull(a.prev)}</strong></span>
                  <span className="text-blue-400">→</span>
                  <span>Current: <strong>{currencyFull(a.curr)}</strong></span>
                  <span className="font-bold text-blue-700 bg-blue-200 px-2 py-0.5 rounded">{a.changePct}%</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Order-level fee tracker */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h3 className="text-sm font-bold text-ink">📋 Order-Level Fee Tracker</h3>
          <p className="text-xs text-outline mt-0.5">Per-order deductions from FK settlement · fees with zero in both periods are hidden</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-surface-container-low border-b border-border">
                <th className="text-left px-5 py-3 text-secondary font-semibold min-w-[200px]">Fee Type</th>
                <th className="text-center px-3 py-3 text-secondary font-semibold">Type</th>
                <th className="text-right px-4 py-3 text-secondary font-semibold">Last 30 Days</th>
                <th className="text-right px-4 py-3 text-secondary font-semibold">Prev 30 Days</th>
                <th className="text-right px-4 py-3 text-secondary font-semibold">Change</th>
                <th className="text-center px-4 py-3 text-secondary font-semibold">Orders (curr)</th>
                <th className="text-center px-4 py-3 text-secondary font-semibold">Trend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {activeOrderFees.length === 0 && (
                <tr><td colSpan={7} className="text-center py-8 text-outline">No fee activity in the last 60 days</td></tr>
              )}
              {activeOrderFees.map(f => (
                <IntelRow key={f.key} row={f} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Non-order deductions tracker */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h3 className="text-sm font-bold text-ink">⚡ Non-Order Deduction Tracker</h3>
          <p className="text-xs text-outline mt-0.5">NEFT-level charges not linked to individual orders</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-surface-container-low border-b border-border">
                <th className="text-left px-5 py-3 text-secondary font-semibold min-w-[200px]">Deduction Type</th>
                <th className="text-right px-4 py-3 text-secondary font-semibold">Last 30 Days</th>
                <th className="text-right px-4 py-3 text-secondary font-semibold">Prev 30 Days</th>
                <th className="text-right px-4 py-3 text-secondary font-semibold">Change</th>
                <th className="text-center px-4 py-3 text-secondary font-semibold">Trend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {nonOrderFees.map(f => (
                <IntelRow key={f.key} row={f} nonOrder />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-[11px] text-secondary">
        <span className="flex items-center gap-1.5"><span className="font-bold text-rose-600">⚡ NEW</span> — first time this fee appeared</span>
        <span className="flex items-center gap-1.5"><span className="font-bold text-amber-600">📈 UP</span> — increased ≥25% and ≥₹100 vs previous period</span>
        <span className="flex items-center gap-1.5"><span className="font-bold text-emerald-600">📉 DOWN</span> — decreased ≥25% and ≥₹100 vs previous period</span>
        <span className="flex items-center gap-1.5"><span className="text-outline">→</span> — stable (within 25%)</span>
      </div>
    </div>
  );
}

function IntelRow({ row, nonOrder }) {
  const isNew  = row.isNew;
  const isUp   = row.isUp;
  const isDown = row.isDown;

  const trendIcon = isNew ? '⚡' : isUp ? '📈' : isDown ? '📉' : '→';
  const rowBg = isNew ? 'bg-rose-50/40' : isUp ? 'bg-amber-50/30' : '';

  const changeCls = isNew
    ? 'text-rose-700 font-bold'
    : row.change > 0 ? 'text-amber-600 font-semibold'
    : row.change < 0 ? 'text-emerald-600 font-semibold'
    : 'text-outline';

  const changeLabel = isNew
    ? <span className="text-rose-600 font-bold flex items-center gap-1">⚡ NEW</span>
    : row.change === 0
    ? <span className="text-outline">No change</span>
    : <span className={changeCls}>
        {row.change > 0 ? '+' : ''}{currencyFull(row.change)}
        &nbsp;
        <span className="text-[10px]">({row.change > 0 ? '+' : ''}{row.changePct}%)</span>
      </span>;

  return (
    <tr className={`hover:bg-surface-container-low/60 transition-colors ${rowBg}`}>
      <td className="px-5 py-2.5">
        <div className="flex items-center gap-2">
          {!nonOrder && row.icon && <span>{row.icon}</span>}
          {nonOrder && row.icon && <span>{row.icon}</span>}
          <span className="font-medium text-ink">{row.label}</span>
          {isNew && <span className="text-[9px] bg-rose-500 text-white px-1.5 py-0.5 rounded-full font-bold">NEW</span>}
        </div>
      </td>
      {!nonOrder && (
        <td className="px-3 py-2.5 text-center">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${row.rateType === 'pct' ? 'bg-primary-container text-primary' : 'bg-emerald-100 text-emerald-600'}`}>
            {row.rateType === 'pct' ? '% rate' : '₹ flat'}
          </span>
        </td>
      )}
      <td className="px-4 py-2.5 text-right font-bold text-ink">{currencyFull(row.curr)}</td>
      <td className="px-4 py-2.5 text-right text-secondary">{row.prev > 0 ? currencyFull(row.prev) : <span className="text-outline">—</span>}</td>
      <td className="px-4 py-2.5 text-right">{changeLabel}</td>
      {!nonOrder && (
        <td className="px-4 py-2.5 text-center text-secondary">{row.nCurr > 0 ? row.nCurr : <span className="text-outline">—</span>}</td>
      )}
      <td className="px-4 py-2.5 text-center text-base">{trendIcon}</td>
    </tr>
  );
}

// ─── RC Entry Reconciliation View (Tab 4 — summary) ──────────────────────────
const FEE_TYPE_META = {
  commission:    { label: 'Commission',    icon: '💸', color: 'indigo',  desc: '% of invoice amount' },
  fixed_fee:     { label: 'Fixed Fee',     icon: '📦', color: 'violet',  desc: '₹ flat per order' },
  pick_pack:     { label: 'Pick & Pack',   icon: '📋', color: 'sky',     desc: '₹ flat per order' },
  franchise_fee: { label: 'Franchise Fee', icon: '🏷️', color: 'amber',   desc: '₹ flat per order' },
};

const MP_OPTIONS = [
  { value: 'flipkart',  label: 'Flipkart' },
  { value: 'amazon',    label: 'Amazon'   },
  { value: 'myntra_vb', label: 'Myntra (VB)', defaultAccount: 'myntra_vb' },
  { value: 'myntra_ej', label: 'Myntra (EJ)', defaultAccount: 'myntra_ej' },
];

function RcEntryRecoView({ data, loading, error, marketplace, sellerAccount, onMpChange, onSaChange, onDrill }) {
  const [expandedType, setExpandedType] = useState('commission');

  if (loading) return <SkeletonBreakdown />;
  if (error)   return <ErrBox msg={error} />;
  if (!data)   return <div className="p-10 text-center text-outline">No data — run a query first</div>;

  const feeTypes = ['commission','fixed_fee','pick_pack','franchise_fee'];

  // Aggregate top-level KPIs across all types
  const allRows = feeTypes.flatMap(t => (data[t] || []).map(r => ({ ...r, fee_type: t })));
  const totalExpected = allRows.reduce((s,r) => s + (+r.expected_fee || 0), 0);
  const totalActual   = allRows.reduce((s,r) => s + (+r.actual_fee   || 0), 0);
  const totalVariance = totalActual - totalExpected;
  const overCount     = allRows.filter(r => (+r.variance) > 1).length;
  const underCount    = allRows.filter(r => (+r.variance) < -1).length;

  return (
    <div className="space-y-5">
      {/* Marketplace selector */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1 bg-surface-container rounded-lg p-1">
          {MP_OPTIONS.map(o => (
            <button key={o.value} onClick={() => { onMpChange(o.value); if (o.defaultAccount) onSaChange(o.defaultAccount); }}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                marketplace === o.value ? 'bg-surface text-ink shadow-sm' : 'text-secondary hover:text-ink'
              }`}>{o.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-secondary font-medium">Seller account:</label>
          <input
            value={sellerAccount}
            onChange={e => onSaChange(e.target.value)}
            className="border border-border rounded-lg px-2.5 py-1.5 text-xs w-32 focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <p className="text-xs text-outline ml-auto">
          Each row = one rate card entry · click a row to see matching orders with variance
        </p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <KPIBox label="Total Expected"  value={`₹${(totalExpected/1000).toFixed(1)}K`} sub={`${allRows.length} RC entries`} color="indigo" />
        <KPIBox label="Total Actual"    value={`₹${(totalActual/1000).toFixed(1)}K`}   sub="FK deducted" color={Math.abs(totalVariance) < 100 ? 'emerald' : totalVariance > 0 ? 'rose' : 'amber'} />
        <KPIBox label="Overcharged Entries" value={overCount}  sub="actual > expected" color={overCount > 0 ? 'rose' : 'emerald'} />
        <KPIBox label="Undercharged Entries" value={underCount} sub="actual < expected" color={underCount > 0 ? 'amber' : 'emerald'} />
      </div>

      {/* Per-fee-type accordion */}
      {feeTypes.map(ft => {
        const rows = data[ft] || [];
        const meta = FEE_TYPE_META[ft];
        if (!rows.length) return null;
        const isOpen = expandedType === ft;
        const typeExpected = rows.reduce((s,r) => s + (+r.expected_fee||0), 0);
        const typeActual   = rows.reduce((s,r) => s + (+r.actual_fee||0), 0);
        const typeVariance = typeActual - typeExpected;

        return (
          <div key={ft} className="bg-surface rounded-xl border border-border overflow-hidden">
            {/* Section header */}
            <button
              className="w-full px-5 py-4 flex items-center gap-3 hover:bg-surface-container-low/60 transition-colors"
              onClick={() => setExpandedType(isOpen ? null : ft)}
            >
              <span className="text-lg">{meta.icon}</span>
              <div className="flex-1 text-left">
                <h3 className="text-sm font-bold text-ink">{meta.label}</h3>
                <p className="text-xs text-outline mt-0.5">{meta.desc} · {rows.length} entries</p>
              </div>
              <div className="flex items-center gap-5 text-right shrink-0">
                <div>
                  <p className="text-[10px] text-outline uppercase tracking-wide">Expected</p>
                  <p className="text-sm font-bold text-ink">₹{(typeExpected/1000).toFixed(1)}K</p>
                </div>
                <div>
                  <p className="text-[10px] text-outline uppercase tracking-wide">Actual</p>
                  <p className="text-sm font-bold text-ink">₹{(typeActual/1000).toFixed(1)}K</p>
                </div>
                <div>
                  <p className="text-[10px] text-outline uppercase tracking-wide">Variance</p>
                  <p className={`text-sm font-bold ${Math.abs(typeVariance) < 50 ? 'text-emerald-600' : typeVariance > 0 ? 'text-rose-600' : 'text-amber-600'}`}>
                    {typeVariance >= 0 ? '+' : ''}₹{typeVariance.toFixed(0)}
                  </p>
                </div>
                <span className={`text-outline transition-transform ${isOpen ? 'rotate-180' : ''}`}>▾</span>
              </div>
            </button>

            {/* Expanded table */}
            {isOpen && (
              <div className="border-t border-border overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-surface-container-low border-b border-border">
                      {['Category','Brand','Date Range','Price Band','Rate','Orders','Settled','Expected Fee','Actual Fee','Variance','Status'].map(h => (
                        <th key={h} className="text-left px-3 py-2.5 text-secondary font-semibold whitespace-nowrap text-[11px]">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {rows.map(r => {
                      const variance = +r.variance || 0;
                      const abv = Math.abs(variance);
                      const isOver  = variance > 1;
                      const isUnder = variance < -1;
                      const statusLabel = abv < 1 ? 'Match' : isOver ? 'Overcharged' : 'Undercharged';
                      const statusCls   = abv < 1
                        ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                        : isOver
                        ? 'bg-rose-100 text-rose-700 border-rose-200'
                        : 'bg-amber-100 text-amber-700 border-amber-200';

                      return (
                        <tr
                          key={r.rc_id}
                          className="hover:bg-indigo-50/40 cursor-pointer transition-colors"
                          onClick={() => onDrill(ft, r.rc_id)}
                          title="Click to drill down into individual orders"
                        >
                          <td className="px-3 py-2.5 font-medium text-ink">{r.category || <span className="text-outline italic">All</span>}</td>
                          <td className="px-3 py-2.5 text-secondary">{r.brand_name || <span className="text-outline">—</span>}</td>
                          <td className="px-3 py-2.5 text-secondary font-mono text-[10px] whitespace-nowrap">
                            {r.start_date ? r.start_date.slice(0,10) : '∞'}
                            {' → '}
                            {r.end_date   ? r.end_date.slice(0,10)   : '∞'}
                          </td>
                          <td className="px-3 py-2.5 text-secondary font-mono text-[10px] whitespace-nowrap">
                            ₹{r.price_min}–{r.price_max === 999999 ? '∞' : `₹${r.price_max}`}
                          </td>
                          <td className="px-3 py-2.5 font-bold text-primary">
                            {r.rate_kind === 'pct' ? `${r.rate}%` : `₹${r.rate}`}
                          </td>
                          <td className="px-3 py-2.5 text-center text-secondary">{r.order_count}</td>
                          <td className="px-3 py-2.5 text-center text-secondary">{r.settled_count}</td>
                          <td className="px-3 py-2.5 text-right text-secondary font-mono">₹{(+r.expected_fee||0).toFixed(0)}</td>
                          <td className="px-3 py-2.5 text-right font-bold text-ink font-mono">₹{(+r.actual_fee||0).toFixed(0)}</td>
                          <td className="px-3 py-2.5 text-right">
                            <span className={`font-bold font-mono ${abv < 1 ? 'text-emerald-600' : isOver ? 'text-rose-600' : 'text-amber-600'}`}>
                              {variance >= 0 ? '+' : ''}₹{variance.toFixed(0)}
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${statusCls}`}>
                              {statusLabel}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      <p className="text-xs text-outline text-center">
        💡 Click any row to drill down · variance = actual FK deduction − expected from rate card
      </p>
    </div>
  );
}

// ─── RC Entry Orders Drill-down View ─────────────────────────────────────────
function RcEntryOrdersView({ feeType, rcId, marketplace, sellerAccount, onBack }) {
  const [page, setPage]         = useState(1);
  const [statusFilter, setStatus] = useState('all');
  const PAGE_SIZE = 50;

  const { data, loading, error } = useFetch(
    () => fetchRcEntryOrders(feeType, rcId, marketplace, sellerAccount, 1, 500),
    [feeType, rcId, marketplace, sellerAccount]
  );
  const [selectedId, setSelectedId] = useState(null);
  const [updatingDisputes, setUpdatingDisputes] = useState({});

  const handleDisputeChange = async (row, status) => {
    try {
      setUpdatingDisputes(p => ({ ...p, [row.order_item_id]: true }));
      await updateDisputeStatus({
        order_item_id: row.order_item_id,
        fee_type: feeType,
        dispute_status: status,
        expected_amount: row.expected_fee,
        actual_amount: row.actual_fee
      });
      row.dispute_status = status;
    } catch (e) {
      alert('Failed to update dispute status: ' + e.message);
    } finally {
      setUpdatingDisputes(p => ({ ...p, [row.order_item_id]: false }));
    }
  };

  const rc      = data?.rcEntry;
  const allRows = data?.data || [];
  const filtered = statusFilter === 'all' ? allRows : allRows.filter(r => r.status === statusFilter);
  const paged    = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const total    = data?.total || 0;

  // Status summary
  const counts = allRows.reduce((acc, r) => { acc[r.status] = (acc[r.status]||0)+1; return acc; }, {});
  const totalVariance = allRows.reduce((s,r) => s + (+r.variance||0), 0);
  const totalExpected = allRows.reduce((s,r) => s + (+r.expected_fee||0), 0);
  const totalActual   = allRows.reduce((s,r) => s + (+r.actual_fee||0), 0);

  const statusBadge = {
    Match:        'bg-emerald-100 text-emerald-700 border-emerald-200',
    Overcharged:  'bg-rose-100 text-rose-700 border-rose-200',
    Undercharged: 'bg-amber-100 text-amber-700 border-amber-200',
    'Zero Fee':   'bg-surface-container text-secondary border-border',
    Unsettled:    'bg-purple-100 text-purple-700 border-purple-200',
  };

  const meta = FEE_TYPE_META[feeType] || {};

  return (
    <>
    <div className="space-y-5">
      {/* Back + header */}
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-secondary hover:text-ink bg-surface-container hover:bg-surface-container-high px-3 py-1.5 rounded-lg transition-colors">
          ← Back to entry list
        </button>
        {rc && (
          <div className="flex items-center gap-2 ml-1 flex-wrap">
            <span className="text-base">{meta.icon}</span>
            <span className="text-sm font-bold text-ink">{meta.label}</span>
            <span className="text-xs text-secondary">
              {rc.category || 'All categories'}
              {rc.brand_name ? ` · ${rc.brand_name}` : ''}
            </span>
            <span className="text-xs font-mono bg-primary-container text-primary px-2 py-0.5 rounded">
              {rc.rate_display}
            </span>
            <span className="text-xs text-outline font-mono">
              {rc.start_date ? rc.start_date.slice(0,10) : '∞'} → {rc.end_date ? rc.end_date.slice(0,10) : '∞'}
            </span>
            <span className="text-xs text-outline font-mono">
              ₹{rc.price_min}–{rc.price_max === 999999 ? '∞' : `₹${rc.price_max}`}
            </span>
          </div>
        )}
      </div>

      {loading && <SkeletonBreakdown />}
      {error && <ErrBox msg={error} />}

      {!loading && !error && data && (
        <>
          {/* KPI summary */}
          <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
            <KPIBox label="Total Orders"     value={total} sub={`${allRows.length} loaded`} color="slate" />
            <KPIBox label="Expected Fee"     value={`₹${(totalExpected/1000).toFixed(1)}K`} sub="rate card computed" color="indigo" />
            <KPIBox label="Actual Fee (FK)"  value={`₹${(totalActual/1000).toFixed(1)}K`}   sub="FK deducted" color={Math.abs(totalVariance) < 50 ? 'emerald' : totalVariance > 0 ? 'rose' : 'amber'} />
            <KPIBox label="Net Variance"     value={`${totalVariance >= 0 ? '+' : ''}₹${totalVariance.toFixed(0)}`} sub={totalVariance > 0 ? 'overcharged by FK' : totalVariance < 0 ? 'undercharged by FK' : 'perfect match'} color={Math.abs(totalVariance) < 50 ? 'emerald' : totalVariance > 0 ? 'rose' : 'amber'} />
            <KPIBox label="Overcharged"      value={counts['Overcharged'] || 0} sub={`${counts['Undercharged'] || 0} undercharged`} color={(counts['Overcharged'] || 0) > 0 ? 'rose' : 'emerald'} />
          </div>

          {/* Status filter pills */}
          <div className="flex gap-2 flex-wrap">
            {[
              ['all',          `All (${allRows.length})`],
              ['Overcharged',  `Overcharged (${counts['Overcharged']||0})`],
              ['Undercharged', `Undercharged (${counts['Undercharged']||0})`],
              ['Match',        `Match (${counts['Match']||0})`],
              ['Zero Fee',     `Zero Fee (${counts['Zero Fee']||0})`],
              ['Unsettled',    `Unsettled (${counts['Unsettled']||0})`],
            ].map(([k, lbl]) => (
              <button key={k} onClick={() => { setStatus(k); setPage(1); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  statusFilter === k ? 'bg-primary text-white' : 'bg-surface border border-border text-secondary hover:bg-surface-container-low'
                }`}>{lbl}</button>
            ))}
          </div>

          {/* Orders table */}
          <div className="bg-surface rounded-xl border border-border overflow-hidden">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between flex-wrap gap-2">
              <p className="text-xs text-secondary font-medium">{filtered.length} orders · sorted by variance (largest first)</p>
              <div className="flex items-center gap-2">
                <button onClick={() => setPage(p => Math.max(1, p-1))} disabled={page === 1}
                  className="px-3 py-1 text-xs rounded-lg border border-border disabled:opacity-40 hover:bg-surface-container-low">← Prev</button>
                <span className="text-xs text-outline">Page {page}/{Math.ceil(filtered.length/PAGE_SIZE)||1}</span>
                <button onClick={() => setPage(p => p+1)} disabled={page*PAGE_SIZE >= filtered.length}
                  className="px-3 py-1 text-xs rounded-lg border border-border disabled:opacity-40 hover:bg-surface-container-low">Next →</button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gradient-to-r from-slate-800 to-slate-700 text-white">
                    {['Order Item ID','Date','Category','Brand','Invoice Amt','Fulfilment','Expected Fee','Actual Fee','Variance','Status', 'Dispute'].map(h => (
                      <th key={h} className="text-left px-3 py-3 font-semibold whitespace-nowrap text-[11px] opacity-90">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {paged.length === 0 && (
                    <tr><td colSpan={11} className="text-center py-8 text-outline">No orders matching this filter</td></tr>
                  )}
                  {(paged || []).map(r => {
                    const variance = +r.variance || 0;
                    const abv = Math.abs(variance);
                    return (
                      <tr key={r.order_item_id}
                        className={`hover:bg-surface-container-low/60 transition-colors ${
                          r.status === 'Overcharged' ? 'bg-rose-50/20' :
                          r.status === 'Undercharged' ? 'bg-amber-50/20' : ''
                        }`}
                      >
                        <td className="px-3 py-2.5">
                          <OrderIdCell id={r.order_item_id} onOpen={setSelectedId} />
                        </td>
                        <td className="px-3 py-2.5 text-outline font-mono text-[10px] whitespace-nowrap">{r.order_date || '—'}</td>
                        <td className="px-3 py-2.5 text-secondary">{r.category || '—'}</td>
                        <td className="px-3 py-2.5 text-secondary">{r.brand_name || '—'}</td>
                        <td className="px-3 py-2.5 text-right font-semibold text-ink">₹{(+r.final_invoice_amount||0).toFixed(0)}</td>
                        <td className="px-3 py-2.5 text-secondary">{r.fulfilment_type || '—'}</td>
                        <td className="px-3 py-2.5 text-right text-secondary font-mono">₹{(+r.expected_fee||0).toFixed(2)}</td>
                        <td className="px-3 py-2.5 text-right font-bold text-ink font-mono">₹{(+r.actual_fee||0).toFixed(2)}</td>
                        <td className="px-3 py-2.5 text-right">
                          <span className={`font-bold font-mono text-[11px] ${
                            abv < 0.5 ? 'text-emerald-600' :
                            variance > 0 ? 'text-rose-600' : 'text-amber-600'
                          }`}>
                            {variance >= 0 ? '+' : ''}₹{variance.toFixed(2)}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap ${statusBadge[r.status] || ''}`}>
                            {r.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
    <OrderDetailDrawer orderItemId={selectedId} onClose={() => setSelectedId(null)} />
    </>
  );
}

function buildAuditExport(issues, summary) {
  const headers = ['Order ID','Date','Category','Price','Status','Fee Type','Expected (₹)','FK Charged (₹)','Difference (₹)','Overcharged?'];
  const rows = (issues || []).flatMap(o =>
    (o.issues || []).map(iss => [
      o.orderItemId, o.orderDate, o.category, o.price,
      STATUS_LABELS[o.status] || o.status,
      iss.fee, iss.expected, iss.actual, iss.diff, iss.overcharged ? 'Yes' : 'No',
    ])
  );
  const summaryRows = [
    ['Orders Checked',      summary.checkedOrders],
    ['Total Discrepancies', summary.issueCount],
    ['Overcharged Count',   summary.overchargedCount],
    ['Total Overcharged ₹', summary.totalOvercharged],
    ['Undercharged Count',  summary.underchargedCount],
    ['Total Undercharged ₹',summary.totalUndercharged],
  ];
  return {
    filename: `Flipkart_RateAudit_${new Date().toISOString().slice(0,10)}`,
    sheets: [
      { sheetName: 'Summary',       headers: ['Metric','Value'], rows: summaryRows, colWidths: [28,16] },
      { sheetName: 'Discrepancies', headers, rows, colWidths: [22,14,20,12,16,18,16,16,16,14] },
    ],
  };
}
