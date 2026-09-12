import { useState, useEffect } from 'react';
import { useFilters } from '../context/FilterContext';
import useFetch from '../hooks/useFetch';
import { fetchSummary, fetchSalesTrend, fetchTopProducts, fetchOrders, fetchAllOrders, fetchBrandSales, fetchBrandTopSkus } from '../api/client';
import ExportButton from '../components/ExportButton';
import PageHeader from '../components/PageHeader';
import { buildSalesExport } from '../utils/exportXlsx';
import KPICard from '../components/KPICard';
import SalesTrendChart from '../components/charts/SalesTrendChart';
import TopProductsChart from '../components/charts/TopProductsChart';
import OrderDetailDrawer, { OrderIdCell } from '../components/OrderDetailDrawer';
import { currency, pct, num, toNum } from '../utils/format';

export default function SalesPage() {
  const { filters, refreshKey } = useFilters();
  const dep = [JSON.stringify(filters), refreshKey];
  const reportFilters = { ...filters, _refresh: refreshKey || undefined };
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState(null);
  const [showRc, setShowRc] = useState(false);

  const { data: summary }    = useFetch(() => fetchSummary(reportFilters), dep);
  const { data: trend }      = useFetch(() => fetchSalesTrend(reportFilters), dep);
  const { data: products }   = useFetch(() => fetchTopProducts(reportFilters, 10), dep);
  const { data: brandSales } = useFetch(() => fetchBrandSales(reportFilters), dep);
  const { data: brandSkus }  = useFetch(() => fetchBrandTopSkus(reportFilters), dep);
  const { data: orders, loading: lo } = useFetch(() => fetchOrders(reportFilters, page), [...dep, page]);

  return (
    <>
    <div className="space-y-6 max-w-[1600px]">
      <PageHeader title="Sales Analysis" subtitle="Order details · all marketplaces" />

      {/* KPIs */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <KPICard title="Total Orders"    value={num(summary?.totalOrders)} sub={`Avg ₹${toNum(summary?.avgOrderValue).toFixed(0)} / order`} color="indigo" icon={<OrderIcon />} />
        <KPICard title="Gross Revenue"   value={currency(summary?.totalRevenue)}  sub="Customer invoice total" color="sky"    icon={<RevIcon />} />
        <KPICard title="Bank Received"   value={currency(summary?.bankReceived ?? summary?.myShare)} sub="Net settlement to bank"  color="emerald" icon={<ShareIcon />} />
        <KPICard title="Return Rate"     value={pct(summary?.returnRate)}          sub={`${num(summary?.returnCount)} of ${num(summary?.totalOrders)} orders`} color="rose" icon={<RetIcon />} />
      </div>

      {/* Charts */}
      <SalesTrendChart data={trend || []} />
      <TopProductsChart data={products || []} />

      {/* Brand sections */}
      <BrandSalesSection data={brandSales} />
      <BrandTopSkusSection data={brandSkus} />

      {/* Orders Table */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink">Orders</h3>
            <p className="text-xs text-outline mt-0.5">{num(orders?.total)} total records</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <ExportButton
              label="Export XLSX"
              buildExport={async () => { const all = await fetchAllOrders(filters); return buildSalesExport(all, filters); }}
            />
            <button
              onClick={() => setShowRc(v => !v)}
              className={`px-3 py-1.5 text-xs rounded-lg border font-medium transition-all ${showRc ? 'bg-primary border-primary text-white' : 'border-border text-secondary hover:bg-surface-container-low'}`}
              title="Show/hide RC-calculated fee columns"
            >
              {showRc ? '✓ ' : ''}RC Fees
            </button>
            <button onClick={() => setPage(p => Math.max(1, p-1))} disabled={page === 1} className="px-3 py-1.5 text-xs rounded-lg border border-border text-secondary disabled:opacity-40 hover:bg-surface-container-low">← Prev</button>
            <span className="text-xs text-secondary">Page {page}</span>
            <button onClick={() => setPage(p => p+1)} disabled={!orders || orders.data.length < 50} className="px-3 py-1.5 text-xs rounded-lg border border-border text-secondary disabled:opacity-40 hover:bg-surface-container-low">Next →</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          {lo ? <TableSkeleton /> : (
            <table className="finance-table">
              <thead>
                <tr className="bg-surface-container-low border-b border-border">
                  {['Order Date','Order Item ID','Category','Fulfilment','State','Zone','QTY','Invoice Amt','Offer Amt','Sale Amt','My Share','Commission','Settlement','Status','Return Type'].map(h => (
                    <th key={h} className="text-left px-4 py-2.5 text-secondary font-medium whitespace-nowrap">{h}</th>
                  ))}
                  {showRc && ['RC Commission','RC Fixed','RC Collection','RC Pick&Pack','RC GST','RC Total Fees','RC Net','COGS','RC Profit','Margin%'].map(h => (
                    <th key={h} className="text-right px-3 py-2.5 text-primary font-semibold whitespace-nowrap bg-primary-container text-[10px]">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {(orders?.data || []).map((o, i) => {
                  const hasRc = o.rcTotalFees != null;
                  const fkComm = toNum(o.commission);
                  const rcComm = toNum(o.rcCommission);
                  const commVar = (hasRc && fkComm > 0) ? rcComm - fkComm : null;
                  return (
                  <tr key={i} className="hover:bg-surface-container-low/60 transition-colors">
                    <td className="px-4 py-2.5 text-secondary whitespace-nowrap">{o.orderDate}</td>
                    <td className="px-4 py-2.5"><OrderIdCell id={o.orderItemId} onOpen={setSelectedId} /></td>
                    <td className="px-4 py-2.5"><CategoryBadge cat={o.category} /></td>
                    <td className="px-4 py-2.5 text-secondary">{o.fulfilmentType}</td>
                    <td className="px-4 py-2.5 text-secondary">{o.deliveryState}</td>
                    <td className="px-4 py-2.5">
                      {o.shippingZone ? (
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${
                          o.shippingZone === 'Local' ? 'bg-emerald-50 text-emerald-700' :
                          o.shippingZone === 'Regional' ? 'bg-blue-50 text-blue-700' :
                          'bg-surface-container text-secondary'
                        }`}>
                          {o.shippingZone}
                        </span>
                      ) : <span className="text-outline">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-ink font-medium text-center">{o.qty}</td>
                    <td className="px-4 py-2.5 text-ink font-medium">₹{toNum(o.finalInvoiceAmount).toFixed(0)}</td>
                    <td className="px-4 py-2.5 text-outline">{o.totalShareAmount != null ? `₹${toNum(o.totalShareAmount).toFixed(0)}` : '—'}</td>
                    <td className="px-4 py-2.5 text-blue-700 font-semibold">₹{toNum(o.saleAmount ?? o.finalInvoiceAmount).toFixed(0)}</td>
                    <td className="px-4 py-2.5 text-emerald-700 font-medium">₹{toNum(o.myShare).toFixed(0)}</td>
                    <td className="px-4 py-2.5 text-rose-600">₹{toNum(o.commission).toFixed(0)}</td>
                    <td className="px-4 py-2.5 text-primary font-medium">₹{toNum(o.settlementAmount).toFixed(0)}</td>
                    <td className="px-4 py-2.5"><StatusBadge status={o.ordersStatus} /></td>
                    <td className="px-4 py-2.5"><ReturnTypeBadge type={o.returnType} /></td>
                    {showRc && !hasRc && (
                      <td colSpan={10} className="px-4 py-2.5 text-center text-outline text-[10px] bg-indigo-50/30">RC not configured</td>
                    )}
                    {showRc && hasRc && (
                      <>
                        <td className="px-3 py-2.5 text-right text-[11px] bg-indigo-50/30 whitespace-nowrap">
                          <span className="text-primary">₹{toNum(o.rcCommission).toFixed(0)}</span>
                          {o.rcCommissionRate != null && <span className="text-indigo-400 ml-1 text-[10px]">({(+o.rcCommissionRate).toFixed(1)}%)</span>}
                          {commVar != null && Math.abs(commVar) > 2 && (
                            <span className={`ml-1 text-[10px] font-bold ${commVar > 0 ? 'text-rose-500' : 'text-emerald-600'}`} title={`RC vs FK variance: ${commVar > 0 ? '+' : ''}₹${commVar.toFixed(0)}`}>
                              {commVar > 0 ? '▲' : '▼'}₹{Math.abs(commVar).toFixed(0)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right text-[11px] text-primary bg-indigo-50/30 whitespace-nowrap">₹{toNum(o.rcFixedFee).toFixed(0)}</td>
                        <td className="px-3 py-2.5 text-right text-[11px] text-primary bg-indigo-50/30 whitespace-nowrap">₹{toNum(o.rcCollectionFee).toFixed(0)}</td>
                        <td className="px-3 py-2.5 text-right text-[11px] text-primary bg-indigo-50/30 whitespace-nowrap">{o.rcPickPack != null ? `₹${toNum(o.rcPickPack).toFixed(0)}` : '—'}</td>
                        <td className="px-3 py-2.5 text-right text-[11px] text-primary bg-indigo-50/30 whitespace-nowrap">₹{toNum(o.rcGstOnFees).toFixed(0)}</td>
                        <td className="px-3 py-2.5 text-right text-[11px] font-semibold text-primary bg-indigo-50/30 whitespace-nowrap">₹{toNum(o.rcTotalFees).toFixed(0)}</td>
                        <td className="px-3 py-2.5 text-right text-[11px] font-medium text-emerald-700 bg-indigo-50/30 whitespace-nowrap">₹{toNum(o.rcNetToSeller).toFixed(0)}</td>
                        <td className="px-3 py-2.5 text-right text-[11px] text-orange-600 bg-indigo-50/30 whitespace-nowrap">{+o.cogs > 0 ? `₹${toNum(o.cogs).toFixed(0)}` : <span className="text-outline">—</span>}</td>
                        <td className={`px-3 py-2.5 text-right text-[11px] font-semibold bg-indigo-50/30 whitespace-nowrap ${+o.rcProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {+o.rcProfit < 0 ? '−' : ''}₹{Math.abs(toNum(o.rcProfit)).toFixed(0)}
                        </td>
                        <td className={`px-3 py-2.5 text-right text-[11px] font-semibold bg-indigo-50/30 whitespace-nowrap ${+o.rcMarginPct >= 20 ? 'text-emerald-600' : +o.rcMarginPct >= 0 ? 'text-amber-600' : 'text-rose-600'}`}>
                          {toNum(o.rcMarginPct).toFixed(1)}%
                        </td>
                      </>
                    )}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>

    <OrderDetailDrawer orderItemId={selectedId} onClose={() => setSelectedId(null)} />
    </>
  );
}

// ── Brand helpers ─────────────────────────────────────────────────────────────
const BRAND_PALETTE = {
  'Youthnic':        { bg: 'bg-primary-container',  text: 'text-primary',  dot: 'bg-primary',  bar: 'bg-primary-container' },
  'Ethnic Junction': { bg: 'bg-emerald-100', text: 'text-emerald-700', dot: 'bg-emerald-500', bar: 'bg-emerald-400' },
  'Sangria':         { bg: 'bg-rose-100',    text: 'text-rose-700',    dot: 'bg-rose-500',    bar: 'bg-rose-400' },
  'Divastri':        { bg: 'bg-purple-100',  text: 'text-purple-700',  dot: 'bg-purple-500',  bar: 'bg-purple-400' },
  'Anmi':            { bg: 'bg-amber-100',   text: 'text-amber-700',   dot: 'bg-amber-500',   bar: 'bg-amber-400' },
  'HERE&NOW':        { bg: 'bg-orange-100',  text: 'text-orange-700',  dot: 'bg-orange-500',  bar: 'bg-orange-400' },
  'Here&Now':        { bg: 'bg-orange-100',  text: 'text-orange-700',  dot: 'bg-orange-500',  bar: 'bg-orange-400' },
};
const BRAND_DEFAULT = { bg: 'bg-surface-container', text: 'text-secondary', dot: 'bg-surface-container-highest', bar: 'bg-surface-container-highest' };
function brandPalette(name) { return BRAND_PALETTE[name] || BRAND_DEFAULT; }

const MP_BADGE = {
  flipkart: 'bg-primary-container text-primary',
  amazon:   'bg-amber-50  text-amber-700',
  myntra:   'bg-pink-50   text-pink-700',
  meesho:   'bg-purple-50 text-purple-700',
  ajio:     'bg-orange-50 text-orange-700',
};
function fmtInr(v) { return toNum(v).toLocaleString('en-IN', { maximumFractionDigits: 0 }); }

// ── BrandSalesSection ─────────────────────────────────────────────────────────
function BrandSalesSection({ data }) {
  const [view, setView] = useState('combined');
  const combined = data?.combined || [];
  const byMp     = data?.byMarketplace || [];
  if (!data) return <SectionSkeleton title="Brand Performance" />;
  if (combined.length === 0) return null;

  const maxRev = Math.max(...combined.map(r => +r.revenue), 1);

  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Brand Performance</h3>
          <p className="text-xs text-outline mt-0.5">{combined.length} brand{combined.length !== 1 ? 's' : ''} · sales &amp; return breakdown</p>
        </div>
        <div className="flex gap-1.5">
          {['combined', 'by-mp'].map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-1.5 text-xs rounded-lg border font-medium transition-all ${view === v ? 'bg-primary border-primary text-white' : 'border-border text-secondary hover:bg-surface-container-low'}`}>
              {v === 'combined' ? 'Combined' : 'By Marketplace'}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        {view === 'combined' ? (
          <table className="finance-table">
            <thead>
              <tr className="bg-surface-container-low border-b border-border">
                {['Brand','Orders','Revenue','My Share','Returns','Return Rate','Revenue Share'].map(h => (
                  <th key={h} className="text-left px-4 py-2.5 text-secondary font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {combined.map(r => {
                const bc = brandPalette(r.brand);
                const barPct = (+r.revenue / maxRev) * 100;
                return (
                  <tr key={r.brand} className="hover:bg-surface-container-low/60 transition-colors">
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${bc.bg} ${bc.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${bc.dot}`} />
                        {r.brand}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink font-medium">{num(r.orders)}</td>
                    <td className="px-4 py-3 text-ink font-semibold">&#8377;{fmtInr(r.revenue)}</td>
                    <td className="px-4 py-3 text-emerald-700 font-medium">&#8377;{fmtInr(r.myShare)}</td>
                    <td className="px-4 py-3 text-rose-600">{num(r.returns)}</td>
                    <td className="px-4 py-3">
                      <span className={`font-semibold ${+r.returnRate > 20 ? 'text-rose-600' : +r.returnRate > 10 ? 'text-amber-600' : 'text-emerald-600'}`}>
                        {(+r.returnRate).toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-4 py-3 w-40">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 bg-surface-container rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${bc.bar}`} style={{ width: `${barPct}%` }} />
                        </div>
                        <span className="text-outline text-[10px] w-8 text-right">{barPct.toFixed(0)}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <table className="finance-table">
            <thead>
              <tr className="bg-surface-container-low border-b border-border">
                {['Marketplace','Brand','Orders','Revenue','My Share','Returns','Return Rate'].map(h => (
                  <th key={h} className="text-left px-4 py-2.5 text-secondary font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {byMp.map((r, idx) => {
                const bc = brandPalette(r.brand);
                return (
                  <tr key={`${r.brand}-${r.marketplace}`}
                    className="hover:bg-surface-container-low/60 transition-colors">
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium capitalize ${MP_BADGE[r.marketplace?.toLowerCase()] || 'bg-surface-container text-secondary'}`}>
                        {r.marketplace}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${bc.bg} ${bc.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${bc.dot}`} />
                        {r.brand}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink">{num(r.orders)}</td>
                    <td className="px-4 py-3 text-ink font-semibold">&#8377;{fmtInr(r.revenue)}</td>
                    <td className="px-4 py-3 text-emerald-700">&#8377;{fmtInr(r.myShare)}</td>
                    <td className="px-4 py-3 text-rose-600">{num(r.returns)}</td>
                    <td className="px-4 py-3">
                      <span className={`font-semibold ${+r.returnRate > 20 ? 'text-rose-600' : +r.returnRate > 10 ? 'text-amber-600' : 'text-emerald-600'}`}>
                        {(+r.returnRate).toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── BrandTopSkusSection ───────────────────────────────────────────────────────
function BrandTopSkusSection({ data }) {
  const brands = Object.keys(data || {});
  const [activeBrand, setActiveBrand] = useState(null);

  useEffect(() => {
    if (brands.length > 0 && (!activeBrand || !brands.includes(activeBrand))) {
      setActiveBrand(brands[0]);
    }
  }, [brands.join(',')]); // eslint-disable-line

  if (!data) return <SectionSkeleton title="Top 25 SKUs by Brand" />;
  if (brands.length === 0) return null;

  const rows   = (activeBrand && data[activeBrand]) || [];
  const bc     = brandPalette(activeBrand || '');
  const maxRev = Math.max(...rows.map(r => +r.revenue), 1);

  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Top 25 SKUs by Brand</h3>
          <p className="text-xs text-outline mt-0.5">Best-selling listing SKUs ranked by gross revenue</p>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {brands.map(brand => {
            const p = brandPalette(brand);
            const isActive = activeBrand === brand;
            return (
              <button key={brand} onClick={() => setActiveBrand(brand)}
                className={`px-3 py-1.5 text-xs rounded-lg border font-medium transition-all ${
                  isActive ? `${p.bg} ${p.text} border-transparent shadow-sm` : 'border-border text-secondary hover:bg-surface-container-low'
                }`}>
                {brand}
                <span className={`ml-1.5 text-[10px] ${isActive ? 'opacity-70' : 'text-outline'}`}>
                  ({data[brand]?.length ?? 0})
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="p-8 text-center text-sm text-outline">No SKU data for {activeBrand}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="finance-table">
            <thead>
              <tr className="bg-surface-container-low border-b border-border">
                {['#','SKU','Product Title','Orders','Revenue','My Share','Returns','Ret%','Bar'].map(h => (
                  <th key={h} className={`text-left px-4 py-2.5 text-secondary font-medium whitespace-nowrap ${h === 'Bar' ? 'w-28' : ''}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {rows.map((r, i) => {
                const barPct = (+r.revenue / maxRev) * 100;
                const hasTitle = r.title && r.title !== r.sku && r.title !== 'Unknown';
                return (
                  <tr key={r.sku} className="hover:bg-surface-container-low/60 transition-colors">
                    <td className="px-4 py-2.5 text-outline font-mono text-[11px]">{i + 1}</td>
                    <td className="px-4 py-2.5 font-mono text-ink text-[11px] whitespace-nowrap">{r.sku}</td>
                    <td className="px-4 py-2.5 text-secondary max-w-xs">
                      {hasTitle
                        ? <span className="block truncate" title={r.title}>{r.title}</span>
                        : <span className="text-outline">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-ink font-medium">{num(r.orders)}</td>
                    <td className="px-4 py-2.5 text-ink font-semibold whitespace-nowrap">&#8377;{fmtInr(r.revenue)}</td>
                    <td className="px-4 py-2.5 text-emerald-700 whitespace-nowrap">&#8377;{fmtInr(r.myShare)}</td>
                    <td className="px-4 py-2.5 text-rose-600">{num(r.returnCount)}</td>
                    <td className="px-4 py-2.5">
                      <span className={`font-semibold ${r.returnRate > 20 ? 'text-rose-600' : r.returnRate > 10 ? 'text-amber-600' : 'text-emerald-600'}`}>
                        {(+r.returnRate).toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-4 py-2.5 w-28">
                      <div className="h-1.5 bg-surface-container rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${bc.bar}`} style={{ width: `${barPct}%` }} />
                      </div>
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
}

function SectionSkeleton({ title }) {
  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      <div className="px-5 py-4 border-b border-border">
        <div className="h-4 w-40 bg-surface-container rounded animate-pulse" />
        <div className="h-3 w-28 bg-surface-container rounded animate-pulse mt-1.5" />
      </div>
      <div className="p-6 space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-8 bg-surface-container rounded animate-pulse" style={{ width: `${75 + Math.random() * 25}%` }} />
        ))}
      </div>
    </div>
  );
}

function CategoryBadge({ cat }) {
  if (!cat) return null;
  return <span className="inline-block bg-primary-container text-primary px-2 py-0.5 rounded-full text-[10px] font-medium">{cat}</span>;
}

function StatusBadge({ status }) {
  if (!status) return <span className="text-outline">—</span>;
  const colors = { completed: 'bg-emerald-50 text-emerald-700', cancelled: 'bg-rose-50 text-rose-700', init: 'bg-amber-50 text-amber-700' };
  const cls = colors[status?.toLowerCase()] || 'bg-surface-container text-secondary';
  return <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${cls}`}>{status}</span>;
}

function ReturnTypeBadge({ type }) {
  if (!type) return <span className="text-outline">—</span>;
  const isCust = type.toLowerCase().includes('customer') || type === 'Return';
  const isRto = type.toLowerCase().includes('courier') || type.toUpperCase().includes('RTO');
  const cls = isCust ? 'bg-orange-50 text-orange-700' : isRto ? 'bg-purple-50 text-purple-700' : 'bg-surface-container text-secondary';
  return <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${cls}`}>{type.replace(/_/g, ' ')}</span>;
}

function TableSkeleton() {
  return (
    <div className="p-6 space-y-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-8 bg-surface-container rounded animate-pulse" style={{ width: `${85 + Math.random()*15}%` }} />
      ))}
    </div>
  );
}

function OrderIcon() { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>; }
function RevIcon()   { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>; }
function ShareIcon() { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>; }
function RetIcon()   { return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>; }
