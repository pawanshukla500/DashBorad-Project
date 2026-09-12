import { useFilters } from '../context/FilterContext';
import useFetch from '../hooks/useFetch';
import { fetchProfitLoss, fetchCharges } from '../api/client';
import { Link } from 'react-router-dom';
import ExportButton from '../components/ExportButton';
import { buildProfitLossExport } from '../utils/exportXlsx';
import KPICard from '../components/KPICard';
import PageHeader from '../components/PageHeader';
import ChartCard from '../components/charts/ChartCard';
import { TOOLTIP_STYLE } from '../components/charts/chartTheme';
import { currency, pct, num, currencyFull } from '../utils/format';
import { useAuth } from '../context/AuthContext';
import {
  ResponsiveContainer, ComposedChart, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Cell,
  PieChart, Pie, Legend, Line,
} from 'recharts';

const FEE_COLORS  = ['#6366f1','#f43f5e','#f59e0b','#10b981','#8b5cf6','#0ea5e9','#ec4899','#14b8a6','#f97316','#64748b'];

export default function ProfitLossPage() {
  const { filters, refreshKey } = useFilters();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const dep = [JSON.stringify(filters), refreshKey];
  const reportFilters = { ...filters, _refresh: refreshKey || undefined };

  const { data: pl, loading, error } = useFetch(() => fetchProfitLoss(reportFilters), dep);
  const { data: charges } = useFetch(fetchCharges, []);

  // Build lookup: key → { enabled, customType, customValue, label }
  const chargesMap = Object.fromEntries((charges || []).map(c => [c.key, c]));
  const isEnabled = (key) => chargesMap[key]?.enabled !== false;

  if (error) return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-6">
      <p className="text-rose-700 font-semibold">Failed to load P&L data</p>
      <p className="text-rose-600 text-xs font-mono mt-1">{error}</p>
    </div>
  );

  const s    = pl?.summary  || {};
  const fees = pl?.fees     || {};
  const trend      = pl?.trend      || [];
  const byCategory = pl?.byCategory || [];

  // Map settlement fee keys to their data values
  const FEE_MAP = [
    { key: 'commission',              name: 'Commission',      value: fees.commission      || 0 },
    { key: 'fixed_fee',               name: 'Fixed Fee',       value: fees.fixedFee        || 0 },
    { key: 'collection_fee',          name: 'Collection Fee',  value: fees.collectionFee   || 0 },
    { key: 'pick_pack_fee',           name: 'Pick & Pack',     value: fees.pickPackFee     || 0 },
    { key: 'shipping_fee',            name: 'Shipping',        value: fees.shippingFee     || 0 },
    { key: 'reverse_shipping',        name: 'Reverse Ship.',   value: fees.reverseShipping || 0 },
    { key: 'tcs',                     name: 'TCS',             value: fees.tcs             || 0 },
    { key: 'tds',                     name: 'TDS',             value: fees.tds             || 0 },
    { key: 'gst_on_mp_fees',          name: 'GST on MP',       value: fees.gstOnMpFees     || 0 },
    { key: 'franchise_fee',           name: 'Franchise Fee',   value: fees.franchiseFee    || 0 },
  ];

  const hiddenFees = FEE_MAP.filter(f => f.value > 0 && !isEnabled(f.key));
  const hiddenCount = hiddenFees.length;
  const hiddenAmount = hiddenFees.reduce((t, f) => t + f.value, 0);

  const feeItems = [
    // Settlement fees — filtered by charges config
    ...FEE_MAP.filter(f => f.value > 0 && isEnabled(f.key)),
    // Custom charges (user-defined)
    ...(charges || [])
      .filter(c => c.source === 'custom' && c.enabled && c.customValue)
      .map(c => {
        let value = +c.customValue;
        if (c.customType === 'per_order')   value = +c.customValue * (s.totalOrders  || 0);
        if (c.customType === 'pct_revenue') value = (+c.customValue / 100) * (s.grossRevenue || 0);
        return { key: c.key, name: c.label, value, isCustom: true };
      })
      .filter(c => c.value > 0),
  ];

  const totalFees = feeItems.reduce((t, f) => t + f.value, 0);
  const customAmount = feeItems.filter(f => f.isCustom).reduce((t, f) => t + f.value, 0);
  // Charges-adjusted view: hide disabled fees, add custom charges into net
  const chargesAdjusted = hiddenAmount > 0 || customAmount > 0;
  const adjustedDeductions = (s.totalDeductions || 0) - hiddenAmount + customAmount;
  const adjustedNetBank = (s.netBank || 0) + hiddenAmount - customAmount;
  const adjustedMargin = s.grossRevenue
    ? ((adjustedNetBank / s.grossRevenue) * 100)
    : 0;

  // Waterfall data — uses adjusted figures when charges differ
  const waterfall = [
    { label: 'Gross Revenue',   value: s.grossRevenue    || 0, color: '#6366f1' },
    { label: 'Bank Received',   value: s.bankReceived    || 0, color: '#0ea5e9' },
    { label: 'Deductions',      value: chargesAdjusted ? adjustedDeductions : (s.totalDeductions || 0), color: '#f43f5e' },
    { label: 'Refund Debited',  value: s.refundDebited   || 0, color: '#f59e0b' },
    { label: 'Net Bank',        value: chargesAdjusted ? adjustedNetBank : (s.netBank || 0), color: '#10b981' },
  ];

  return (
    <div className="space-y-6 max-w-[1600px]">
      <PageHeader
        title="P&L Summary"
        subtitle="Settlement P&L from orders · returns · bank receipts"
      >
        {isAdmin && (
          <Link to="/charges" className="text-xs text-primary hover:text-indigo-dark flex items-center gap-1 border border-primary/25 px-3 py-1.5 rounded-lg hover:bg-primary/5 transition-colors font-medium">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
            Configure Charges
          </Link>
        )}
        <ExportButton label="Export Full P&L" buildExport={() => buildProfitLossExport(pl)} disabled={!pl} />
      </PageHeader>

      {chargesAdjusted && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
          KPIs below are <strong>charges-adjusted</strong>
          {hiddenCount > 0 && <> — {hiddenCount} fee type{hiddenCount > 1 ? 's' : ''} hidden ({currency(hiddenAmount)})</>}
          {customAmount > 0 && <> — custom charges {currency(customAmount)} included</>}
          . Settlement bank figures still come from uploaded data.
        </div>
      )}

      {loading && <LoadingSkeleton />}

      {!loading && (
        <>
          {/* KPI Row 1 */}
          <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
            <KPICard
              title="Gross Revenue"
              value={currency(s.grossRevenue)}
              sub={`${num(s.totalOrders)} orders invoiced`}
              color="indigo"
              icon={<RevIcon />}
            />
            <KPICard
              title="Bank Received"
              value={currency(s.bankReceived)}
              sub="Actual positive settlements"
              color="sky"
              icon={<BankIcon />}
            />
            <KPICard
              title={chargesAdjusted ? 'Adjusted Deductions' : 'Marketplace Deductions'}
              value={currency(chargesAdjusted ? adjustedDeductions : s.totalDeductions)}
              sub={chargesAdjusted ? `Settlement raw: ${currency(s.totalDeductions)}` : 'Commission + all fees'}
              color="rose"
              icon={<FeeIcon />}
            />
          </div>

          {/* KPI Row 2 */}
          <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
            <KPICard
              title="Refund Debited"
              value={currency(s.refundDebited)}
              sub={`${num(s.returnCount)} return orders`}
              color="amber"
              icon={<RefundIcon />}
            />
            <KPICard
              title={chargesAdjusted ? 'Adjusted Net' : 'Net Bank Receipt'}
              value={currency(chargesAdjusted ? adjustedNetBank : s.netBank)}
              sub={`${(chargesAdjusted ? adjustedMargin : +(s.marginPct || 0)).toFixed(1)}% margin on revenue`}
              color="emerald"
              icon={<NetIcon />}
            />
            <KPICard
              title="Unsettled Amount"
              value={currency(s.unsettledAmount)}
              sub={`${num(s.unsettledCount)} orders pending`}
              color="purple"
              icon={<PendingIcon />}
            />
          </div>

          {/* P&L Flow + Fee Pie */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {/* Revenue Flow */}
            <div className="bg-surface rounded-xl border border-border p-5">
              <h3 className="text-sm font-semibold text-ink mb-0.5">Revenue Flow</h3>
              <p className="text-xs text-outline mb-4">From gross to net — how money moves</p>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={waterfall} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => currency(v)} tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={60} />
                  <Tooltip formatter={v => [currencyFull(v)]} contentStyle={TOOLTIP_STYLE} />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                    {waterfall.map((b, i) => <Cell key={i} fill={b.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Fee Breakdown Pie */}
            <div className="bg-surface rounded-xl border border-border p-5">
              <div className="flex items-start justify-between mb-0.5">
                <h3 className="text-sm font-semibold text-ink">Fee Breakdown</h3>
                {hiddenCount > 0 && isAdmin && (
                  <Link to="/charges" className="text-[10px] text-outline hover:text-[#902A4A]">
                    {hiddenCount} hidden · Configure
                  </Link>
                )}
                {hiddenCount > 0 && !isAdmin && (
                  <span className="text-[10px] text-outline">{hiddenCount} fee types hidden</span>
                )}
              </div>
              <p className="text-xs text-outline mb-4">
                Enabled deductions{chargesAdjusted ? ` · showing ${currency(totalFees)}` : ' from settlement data'}
              </p>
              {feeItems.length === 0 ? (
                <div className="h-64 flex items-center justify-center text-outline text-sm">No fee data in settlement rows</div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie data={feeItems} dataKey="value" nameKey="name" cx="50%" cy="50%"
                      innerRadius={55} outerRadius={95} paddingAngle={3} strokeWidth={0}>
                      {feeItems.map((_, i) => <Cell key={i} fill={FEE_COLORS[i % FEE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v, name) => [currencyFull(v), name]} contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Fee Detail Cards */}
          {feeItems.length > 0 && (
            <div className="bg-surface rounded-xl border border-border p-5">
              <h3 className="text-sm font-semibold text-ink mb-4">Fee Components</h3>
              <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
                {feeItems.map((f, i) => (
                  <div key={i} className={`bg-surface-container-low rounded-lg p-3 border ${f.isCustom ? 'border-emerald-200 bg-emerald-50/40' : 'border-border'}`}>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: FEE_COLORS[i % FEE_COLORS.length] }} />
                      <p className="text-[11px] text-secondary truncate">{f.name}</p>
                      {f.isCustom && <span className="text-[9px] bg-emerald-100 text-emerald-700 px-1 rounded font-medium ml-auto shrink-0">custom</span>}
                    </div>
                    <p className="text-sm font-bold text-ink">{currency(f.value)}</p>
                    <p className="text-[10px] text-outline mt-0.5">
                      {totalFees > 0 ? ((+f.value / +totalFees) * 100).toFixed(1) : 0}% of deductions
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* P&L Trend */}
          {trend.length > 0 && (
            <div className="bg-surface rounded-xl border border-border p-5">
              <h3 className="text-sm font-semibold text-ink mb-0.5">P&L Trend</h3>
              <p className="text-xs text-outline mb-4">Revenue vs net settlement over time</p>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={trend} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f8fafc" />
                  <XAxis dataKey="period" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => currency(v)} tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={64} />
                  <Tooltip
                    formatter={(v, name) => [currencyFull(v), name]}
                    contentStyle={TOOLTIP_STYLE}
                    labelStyle={{ color: '#475569', fontWeight: 600, marginBottom: 4 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                  <Bar dataKey="revenue"      name="Gross Revenue"   fill="#6366f1" opacity={0.3} radius={[3,3,0,0]} maxBarSize={40} />
                  <Bar dataKey="bankReceived" name="Bank Received"   fill="#0ea5e9" opacity={0.8} radius={[3,3,0,0]} maxBarSize={40} />
                  <Bar dataKey="refunds"      name="Refund Debited"  fill="#f59e0b" opacity={0.8} radius={[3,3,0,0]} maxBarSize={40} />
                  <Line type="monotone" dataKey="net" name="Net Settlement" stroke="#10b981" strokeWidth={2.5} dot={{ r: 3, fill: '#10b981' }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Category P&L Table */}
          <div className="bg-surface rounded-xl border border-border overflow-hidden">
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-sm font-semibold text-ink">Category P&L</h3>
              <p className="text-xs text-outline mt-0.5">
                Real settlement data per category — orders · returns · bank received · net
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="finance-table">
                <thead>
                  <tr className="bg-surface-container-low border-b border-border">
                    {['Category','Orders','Returns','Return Rate','Gross Revenue','Bank Received','Deductions','Refund Debited','Net Bank','Margin %'].map(h => (
                      <th key={h} className="text-left px-4 py-3 text-secondary font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {byCategory.map((c, i) => (
                    <tr key={i} className="hover:bg-surface-container-low/60 transition-colors">
                      <td className="px-4 py-3">
                        <span className="inline-block bg-indigo-50 text-indigo-700 border border-indigo-200/80 px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize whitespace-nowrap">{c.category ? c.category.replace(/_/g, ' ') : '—'}</span>
                      </td>
                      <td className="px-4 py-3 text-ink font-medium">{num(c.orders)}</td>
                      <td className="px-4 py-3 text-secondary">{num(c.returns)}</td>
                      <td className="px-4 py-3">
                        <span className={`font-semibold ${c.returnRate > 15 ? 'text-rose-600' : c.returnRate > 8 ? 'text-amber-600' : 'text-emerald-600'}`}>
                          {pct(c.returnRate)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-primary font-medium">{currency(c.revenue)}</td>
                      <td className="px-4 py-3 text-sky-700 font-medium">{currency(c.bankReceived)}</td>
                      <td className="px-4 py-3 text-rose-600">{currency(c.deductions)}</td>
                      <td className="px-4 py-3 text-amber-600">{currency(c.refunds)}</td>
                      <td className="px-4 py-3">
                        <span className={`font-bold ${c.net >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{currency(c.net)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <MarginBadge pct={c.margin} />
                      </td>
                    </tr>
                  ))}

                  {/* Totals row */}
                  {byCategory.length > 0 && (() => {
                    const tot = byCategory.reduce((acc, c) => ({
                      orders:       acc.orders       + (+c.orders       || 0),
                      returns:      acc.returns      + (+c.returns      || 0),
                      revenue:      acc.revenue      + (+c.revenue      || 0),
                      bankReceived: acc.bankReceived + (+c.bankReceived  || 0),
                      deductions:   acc.deductions   + (+c.deductions   || 0),
                      refunds:      acc.refunds      + (+c.refunds      || 0),
                      net:          acc.net          + (+c.net          || 0),
                    }), { orders:0, returns:0, revenue:0, bankReceived:0, deductions:0, refunds:0, net:0 });
                    const totMargin = tot.revenue > 0 ? (tot.net / tot.revenue) * 100 : 0;
                    const totRetRate = tot.orders > 0 ? (tot.returns / tot.orders) * 100 : 0;
                    return (
                      <tr className="bg-surface-container-low border-t-2 border-border font-semibold">
                        <td className="px-4 py-3 text-ink">Total</td>
                        <td className="px-4 py-3 text-ink">{num(tot.orders)}</td>
                        <td className="px-4 py-3 text-ink">{num(tot.returns)}</td>
                        <td className="px-4 py-3">
                          <span className={`font-semibold ${totRetRate > 15 ? 'text-rose-600' : totRetRate > 8 ? 'text-amber-600' : 'text-emerald-600'}`}>
                            {pct(totRetRate)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-primary">{currency(tot.revenue)}</td>
                        <td className="px-4 py-3 text-sky-800">{currency(tot.bankReceived)}</td>
                        <td className="px-4 py-3 text-rose-700">{currency(tot.deductions)}</td>
                        <td className="px-4 py-3 text-amber-700">{currency(tot.refunds)}</td>
                        <td className="px-4 py-3">
                          <span className={`font-bold ${tot.net >= 0 ? 'text-emerald-800' : 'text-rose-800'}`}>{currency(tot.net)}</span>
                        </td>
                        <td className="px-4 py-3">
                          <MarginBadge pct={totMargin} />
                        </td>
                      </tr>
                    );
                  })()}
                </tbody>
              </table>
            </div>
          </div>

          {/* Return Impact Summary */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="bg-surface rounded-xl border border-border p-5">
              <h3 className="text-sm font-semibold text-ink mb-4">Return Impact</h3>
              <div className="space-y-3">
                <StatRow label="Total Orders"      value={num(s.totalOrders)} />
                <StatRow label="Return Orders"     value={num(s.returnCount)}   valueColor="text-rose-600" />
                <StatRow label="Return Rate"       value={pct(s.returnRate)}    valueColor={s.returnRate > 15 ? 'text-rose-600' : s.returnRate > 8 ? 'text-amber-600' : 'text-emerald-600'} />
                <StatRow label="Refund Debited"    value={currency(s.refundDebited)} valueColor="text-amber-700" />
              </div>
            </div>

            <div className="bg-surface rounded-xl border border-border p-5">
              <h3 className="text-sm font-semibold text-ink mb-4">Settlement Health</h3>
              <div className="space-y-3">
                <StatRow label="Gross Revenue"     value={currency(s.grossRevenue)} />
                <StatRow label="Bank Received"     value={currency(s.bankReceived)}    valueColor="text-sky-700" />
                <StatRow label="Gap (unsettled)"   value={currency(s.unsettledAmount)} valueColor="text-amber-700" />
                <StatRow label="Unsettled Orders"  value={num(s.unsettledCount)}       valueColor="text-amber-700" />
              </div>
            </div>

            <div className="bg-surface rounded-xl border border-border p-5">
              <h3 className="text-sm font-semibold text-ink mb-4">Net Summary</h3>
              <div className="space-y-3">
                <StatRow label="Bank Received"     value={currency(s.bankReceived)} />
                <StatRow label="Flipkart Fees"     value={currency(s.totalDeductions)} valueColor="text-rose-600" />
                <StatRow label="Refund Debited"    value={currency(s.refundDebited)}   valueColor="text-amber-600" />
                <div className="border-t border-border pt-3 flex justify-between items-center">
                  <span className="text-xs font-bold text-ink">Net Bank</span>
                  <span className={`text-sm font-bold ${(s.netBank || 0) >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{currency(s.netBank)}</span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MarginBadge({ pct: p }) {
  const cls = p > 20 ? 'bg-emerald-50 text-emerald-700' : p > 10 ? 'bg-sky-50 text-sky-700' : p > 0 ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-700';
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${cls}`}>{(+(p || 0)).toFixed(1)}%</span>;
}

function StatRow({ label, value, valueColor = 'text-ink' }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-xs text-secondary">{label}</span>
      <span className={`text-xs font-semibold ${valueColor}`}>{value}</span>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="grid grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-24 bg-surface-container rounded-xl" />)}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="h-72 bg-surface-container rounded-xl" />
        <div className="h-72 bg-surface-container rounded-xl" />
      </div>
      <div className="h-64 bg-surface-container rounded-xl" />
      <div className="h-80 bg-surface-container rounded-xl" />
    </div>
  );
}

function RevIcon()     { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>; }
function BankIcon()    { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>; }
function FeeIcon()     { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>; }
function RefundIcon()  { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>; }
function NetIcon()     { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2z" /></svg>; }
function PendingIcon() { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>; }
