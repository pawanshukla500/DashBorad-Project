import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid, Cell, PieChart, Pie,
} from 'recharts';
import {
  fetchProfitAnalysis,
  fetchSkuMaster, fetchUnmappedSkus,
  uploadSkuMasterFile, addSkuMasterRow, updateSkuMasterRow,
  deleteSkuMasterRow, clearSkuMaster,
  mergeSingleSku, fetchVbExportSkus, updateVbExportSku, fetchUnmergedSkus,
  downloadVbExportPrefilledTemplate,
} from '../api/client';
import { useFilters } from '../context/FilterContext';
import useFetch from '../hooks/useFetch';
import { useAnimatedDisplayValue } from '../hooks/useAnimatedDisplayValue';
import {
  currencyCompact,
  currencyRounded as rupee,
  formatNumber as fmt,
  percentageOrDash as pct,
} from '../utils/format';

// ── Formatters ──────────────────────────────────────────────────────────────────
const fmtK = (v) => currencyCompact(v, '—');

// ── Weight slab: stored as upper-bound number, displayed as range ───────────────
export const WEIGHT_SLABS = [
  { value: 0.5,  label: '0 – 0.5 kg' },
  { value: 1,    label: '0.5 – 1 kg' },
  { value: 1.5,  label: '1 – 1.5 kg' },
  { value: 2,    label: '1.5 – 2 kg' },
  { value: 3,    label: '2 – 3 kg' },
  { value: 5,    label: '3 – 5 kg' },
  { value: 10,   label: '5 – 10 kg' },
];

export function fmtWeightSlab(v) {
  if (v == null || v === '') return '—';
  const found = WEIGHT_SLABS.find(s => +s.value === +v);
  return found ? found.label : `${v} kg`;
}

// ── Suggest Base VB EXPORT SKU from Listing SKU ────────────────────────────────
export function suggestVbSku(listingSku) {
  if (!listingSku) return '';
  return String(listingSku)
    .replace(/[_-](?:INFNew|AI|New|FK|M|AZ|FBA|Flex|B2B|B2C)$/i, '')
    .replace(/[_-][SMLXL23456]+(?:[_-]New)?$/i, '')
    .trim();
}

// ── Marketplace Badges ──────────────────────────────────────────────────────────
const MP_BADGE = {
  flipkart: 'bg-primary-container text-primary',
  amazon:   'bg-amber-100 text-amber-700',
  myntra:   'bg-pink-100 text-pink-700',
  meesho:   'bg-purple-100 text-purple-700',
  all:      'bg-surface-container text-secondary',
};
function mpCls(mp) { return MP_BADGE[(mp||'').toLowerCase()] || 'bg-surface-container text-secondary'; }

// ── KPI card ────────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, color = 'slate', icon, trend }) {
  const colors = {
    slate:   'bg-surface border-border text-ink',
    indigo:  'bg-primary-container border-primary text-primary',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    rose:    'bg-rose-50 border-rose-200 text-rose-700',
    amber:   'bg-amber-50 border-amber-200 text-amber-700',
    violet:  'bg-violet-50 border-violet-200 text-violet-700',
  };
  const trendColor = trend > 0 ? 'text-emerald-600' : trend < 0 ? 'text-rose-500' : 'text-outline';
  const animatedValue = useAnimatedDisplayValue(value);

  return (
    <div className={`rounded-xl border px-5 py-4 shadow-sm ${colors[color]}`}>
      <div className="flex items-start justify-between mb-2">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-secondary">{label}</p>
        {icon && <span className="text-lg opacity-60">{icon}</span>}
      </div>
      <p className={`text-financial-lg font-semibold leading-tight tabular-nums ${color !== 'slate' ? '' : 'text-ink'}`}>{animatedValue}</p>
      {sub && <p className="text-xs text-outline mt-0.5">{sub}</p>}
      {trend != null && (
        <p className={`text-xs font-medium mt-1 ${trendColor}`}>
          {trend > 0 ? '▲' : trend < 0 ? '▼' : '●'} {Math.abs(+trend).toFixed(1)}% margin
        </p>
      )}
    </div>
  );
}

// ── Fee breakdown row ────────────────────────────────────────────────────────────
function FeeRow({ fees }) {
  const items = [
    { label: 'Commission',    value: fees?.commission },
    { label: 'Fixed Fee',     value: fees?.fixedFee },
    { label: 'Collection',    value: fees?.collectionFee },
    { label: 'Pick & Pack',   value: fees?.pickPack },
    { label: 'Shipping',      value: fees?.shipping },
    { label: 'Rev. Shipping', value: fees?.reverseShipping },
    { label: 'TCS',           value: fees?.tcs },
    { label: 'TDS',           value: fees?.tds },
    { label: 'GST on Fees',   value: fees?.gstOnFees },
  ].filter(x => x.value != null && x.value !== 0);

  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(it => (
        <div key={it.label} className="flex items-center gap-1.5 bg-surface-container rounded-lg px-3 py-1.5">
          <span className="text-[11px] text-secondary font-medium">{it.label}</span>
          <span className="text-[11px] font-bold text-ink">₹{fmt(it.value, 0)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Waterfall flow diagram ───────────────────────────────────────────────────────
function ProfitFlow({ s }) {
  if (!s) return null;
  const items = [
    { label: 'Gross Revenue',  value: s.grossRevenue,       color: 'bg-blue-500',    pctOfRev: 100 },
    { label: '– Marketplace Fees', value: -s.fkTotalFees,   color: 'bg-amber-400',   pctOfRev: s.grossRevenue > 0 ? -((s.fkTotalFees/s.grossRevenue)*100) : 0 },
    { label: '– Returns',      value: -s.totalRefunds,      color: 'bg-rose-400',    pctOfRev: s.grossRevenue > 0 ? -((s.totalRefunds/s.grossRevenue)*100) : 0 },
    { label: '– COGS',         value: -s.totalCogs,         color: 'bg-orange-400',  pctOfRev: s.grossRevenue > 0 ? -((s.totalCogs/s.grossRevenue)*100) : 0 },
    { label: '= Gross Profit', value: s.grossProfit,        color: s.grossProfit >= 0 ? 'bg-emerald-500' : 'bg-rose-600', pctOfRev: s.profitMarginPct },
  ];

  const max = Math.max(...items.map(x => Math.abs(x.value)));

  return (
    <div className="space-y-2">
      {items.map(it => (
        <div key={it.label} className="flex items-center gap-3">
          <div className="w-32 text-xs text-secondary text-right shrink-0">{it.label}</div>
          <div className="flex-1 relative h-6 bg-surface-container rounded overflow-hidden">
            <div
              className={`h-full ${it.color} rounded transition-all`}
              style={{ width: `${max > 0 ? (Math.abs(it.value) / max) * 100 : 0}%` }}
            />
          </div>
          <div className="w-28 text-xs font-semibold text-right shrink-0">
            <span className={it.value < 0 ? 'text-rose-600' : 'text-ink'}>
              {it.value < 0 ? '−' : ''}₹{fmt(Math.abs(it.value), 0)}
            </span>
            <span className="text-outline ml-1">({Math.abs(+it.pctOfRev).toFixed(1)}%)</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Custom Recharts Tooltip ──────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface border border-border shadow-lg rounded-xl px-4 py-3 text-xs">
      <p className="font-semibold text-ink mb-2">{label}</p>
      {payload.map(p => (
        <div key={p.dataKey} className="flex items-center gap-2 mb-0.5">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: p.color }} />
          <span className="text-secondary">{p.name}:</span>
          <span className="font-semibold text-ink">₹{fmt(p.value, 0)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Tab pill ────────────────────────────────────────────────────────────────────
function Tab({ label, active, onClick, badge }) {
  return (
    <button
      onClick={onClick}
      className={`relative px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 whitespace-nowrap ${
        active ? 'bg-primary text-white shadow-sm' : 'text-secondary hover:text-ink hover:bg-surface-container'
      }`}
    >
      <span>{label}</span>
      {badge > 0 && (
        <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
          active ? 'bg-white text-primary' : 'bg-amber-500 text-white'
        }`}>
          {badge}
        </span>
      )}
    </button>
  );
}

// ── Trend chart ─────────────────────────────────────────────────────────────────
function TrendChart({ data }) {
  if (!data?.length) return <div className="text-center text-outline py-12 text-sm">No data for selected filters</div>;

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="period" tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} />
        <YAxis
          tickFormatter={v => fmtK(v).replace('₹', '')}
          tick={{ fontSize: 11, fill: '#94a3b8' }}
          tickLine={false}
          axisLine={false}
          width={52}
        />
        <Tooltip content={<ChartTooltip />} />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
        <Bar dataKey="revenue"     name="Revenue"      fill="#818cf8" radius={[3,3,0,0]} maxBarSize={40} />
        <Bar dataKey="fkTotalFees" name="Fees"         fill="#fbbf24" radius={[3,3,0,0]} maxBarSize={40} />
        <Bar dataKey="cogs"        name="COGS"         fill="#fb923c" radius={[3,3,0,0]} maxBarSize={40} />
        <Line dataKey="grossProfit" name="Gross Profit" stroke="#10b981" strokeWidth={2.5} dot={{ r: 3 }} type="monotone" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── Fee pie chart ────────────────────────────────────────────────────────────────
const PIE_COLORS = ['#818cf8','#fbbf24','#34d399','#f472b6','#a78bfa','#60a5fa','#f87171','#4ade80','#c084fc'];

function FeePie({ fees, total }) {
  if (!fees || total === 0) return null;
  const data = [
    { name: 'Commission',    value: fees.commission },
    { name: 'Fixed Fee',     value: fees.fixedFee },
    { name: 'Collection',    value: fees.collectionFee },
    { name: 'Pick & Pack',   value: fees.pickPack },
    { name: 'Shipping',      value: fees.shipping },
    { name: 'Rev. Shipping', value: fees.reverseShipping },
    { name: 'TCS',           value: fees.tcs },
    { name: 'TDS',           value: fees.tds },
    { name: 'GST on Fees',   value: fees.gstOnFees },
  ].filter(d => d.value > 0);

  return (
    <div className="flex items-center gap-6">
      <PieChart width={140} height={140}>
        <Pie data={data} dataKey="value" cx={65} cy={65} innerRadius={38} outerRadius={62} paddingAngle={2}>
          {data.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
        </Pie>
        <Tooltip formatter={(v) => `₹${fmt(v, 0)}`} />
      </PieChart>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        {data.map((d, i) => (
          <div key={d.name} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
            <span className="text-[11px] text-secondary">{d.name}</span>
            <span className="text-[11px] font-semibold text-ink ml-auto pl-2">₹{fmt(d.value, 0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Table helpers ────────────────────────────────────────────────────────────────
function Th({ children, right = false, onClick = null, sorted = false, sortDir = 'desc' }) {
  return (
    <th
      onClick={onClick}
      className={`px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-outline whitespace-nowrap ${
        right ? 'text-right' : 'text-left'
      } ${onClick ? 'cursor-pointer select-none hover:text-ink transition-colors' : ''}`}
    >
      <div className={`inline-flex items-center gap-1 ${right ? 'justify-end' : ''}`}>
        <span>{children}</span>
        {sorted && <span className="text-primary font-bold">{sortDir === 'asc' ? '↑' : '↓'}</span>}
      </div>
    </th>
  );
}
function Td({ children, right = false, bold = false, color = '', colSpan = 1 }) {
  return <td colSpan={colSpan} className={`px-3 py-2 text-xs whitespace-nowrap ${right ? 'text-right' : ''} ${bold ? 'font-semibold' : ''} ${color || 'text-ink'}`}>{children}</td>;
}
function GpCell({ value }) {
  if (value == null) return <Td right>—</Td>;
  const n = +value;
  return <Td right bold color={n >= 0 ? 'text-emerald-600' : 'text-rose-600'}>{n < 0 ? '−' : ''}₹{fmt(Math.abs(n), 0)}</Td>;
}
function MarginCell({ value }) {
  if (value == null) return <Td right>—</Td>;
  const n = +value;
  const color = n >= 20 ? 'text-emerald-600' : n >= 0 ? 'text-amber-600' : 'text-rose-600';
  return <Td right bold color={color}>{n.toFixed(1)}%</Td>;
}

const CATEGORY_TONES = [
  'bg-indigo-50 text-indigo-700 border-indigo-200',
  'bg-sky-50 text-sky-700 border-sky-200',
  'bg-teal-50 text-teal-700 border-teal-200',
  'bg-violet-50 text-violet-700 border-violet-200',
  'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200',
  'bg-cyan-50 text-cyan-700 border-cyan-200',
];

function categoryTone(category) {
  const text = String(category || 'Uncategorized');
  const hash = [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return CATEGORY_TONES[hash % CATEGORY_TONES.length];
}

// ── Modal: Edit COGS & Weight Slab for a VB EXPORT SKU ────────────────────────
function VbSkuEditModal({ skuItem, onClose, onSaved }) {
  const [form, setForm] = useState({
    cogs: skuItem?.cogs || '',
    weight_slab: skuItem?.weightSlab != null ? skuItem.weightSlab : '',
    category: skuItem?.category || '',
    product_name: skuItem?.productName || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await updateVbExportSku(skuItem.vbExportSku, form);
      onSaved();
      onClose();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop p-4">
      <div className="bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div>
            <h3 className="text-base font-bold text-ink">Configure VB EXPORT SKU</h3>
            <p className="font-mono text-xs text-primary font-semibold mt-0.5">{skuItem.vbExportSku}</p>
          </div>
          <button onClick={onClose} className="text-secondary hover:text-ink text-xl leading-none">&times;</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-secondary mb-1">COGS (₹ / Unit)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.cogs}
                onChange={e => setForm(f => ({ ...f, cogs: e.target.value }))}
                placeholder="0.00"
                className="w-full text-xs border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary bg-surface font-semibold text-ink"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-secondary mb-1">Weight Slab</label>
              <select
                value={form.weight_slab}
                onChange={e => setForm(f => ({ ...f, weight_slab: e.target.value }))}
                className="w-full text-xs border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary bg-surface"
              >
                <option value="">— select weight slab —</option>
                {WEIGHT_SLABS.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-secondary mb-1">Product Category</label>
            <input
              type="text"
              value={form.category}
              onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
              placeholder="e.g. Ethnic Jacket, Kurtis"
              className="w-full text-xs border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary bg-surface"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-secondary mb-1">Product Name / Title</label>
            <input
              type="text"
              value={form.product_name}
              onChange={e => setForm(f => ({ ...f, product_name: e.target.value }))}
              placeholder="e.g. Silk Blend Printed Jacket"
              className="w-full text-xs border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary bg-surface"
            />
          </div>

          {error && <p className="text-xs text-rose-600 bg-rose-50 p-2 rounded-lg">✗ {error}</p>}

          <p className="text-[11px] text-outline">
            Updating COGS and Weight Slab cascades to all {skuItem.listingCount || 1} marketplace listing SKUs mapped to this VB EXPORT SKU.
          </p>

          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-secondary hover:text-ink border border-border rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-xs font-bold text-white bg-primary hover:bg-primary-hover rounded-lg shadow-sm disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Modal: Merge Marketplace Listing SKU into VB EXPORT SKU ──────────────────
function MergeSkuModal({ listingItem, onClose, onMerged }) {
  const suggested = useMemo(() => suggestVbSku(listingItem?.sku), [listingItem]);
  const [form, setForm] = useState({
    listing_sku: listingItem?.sku || '',
    master_sku: suggested || listingItem?.sku || '',
    category: listingItem?.category || '',
    marketplace: listingItem?.marketplace || 'all',
    cogs: '',
    weight_slab: '',
    product_name: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.master_sku.trim()) {
      setError('Master / VB EXPORT SKU is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await mergeSingleSku(form);
      onMerged();
      onClose();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop p-4">
      <div className="bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div>
            <h3 className="text-base font-bold text-ink">Merge Marketplace Listing SKU</h3>
            <p className="text-xs text-secondary mt-0.5">Map to master VB EXPORT SKU to unify COGS and order reporting</p>
          </div>
          <button onClick={onClose} className="text-secondary hover:text-ink text-xl leading-none">&times;</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="bg-surface-container-low p-3 rounded-xl space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-secondary">Marketplace Listing SKU:</span>
              <span className="font-mono text-xs font-bold text-ink">{listingItem?.sku}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-secondary">Marketplace & Orders:</span>
              <span className="text-xs text-secondary">
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold capitalize mr-2 ${mpCls(listingItem?.marketplace)}`}>
                  {listingItem?.marketplace}
                </span>
                {listingItem?.order_count || listingItem?.orders} orders ({fmtK(listingItem?.total_revenue || listingItem?.revenue)})
              </span>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold text-secondary">VB EXPORT SKU (Master SKU) *</label>
              {suggested && suggested !== form.master_sku && (
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, master_sku: suggested }))}
                  className="text-[10px] text-primary hover:underline font-semibold"
                >
                  Use suggestion: {suggested}
                </button>
              )}
            </div>
            <input
              type="text"
              required
              value={form.master_sku}
              onChange={e => setForm(f => ({ ...f, master_sku: e.target.value }))}
              placeholder="e.g. EJ1201-16001"
              className="w-full text-xs border border-border rounded-lg px-3 py-2 font-mono focus:outline-none focus:ring-2 focus:ring-primary bg-surface font-semibold text-ink"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-secondary mb-1">Category</label>
              <input
                type="text"
                value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                placeholder="Product category"
                className="w-full text-xs border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary bg-surface"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-secondary mb-1">Weight Slab</label>
              <select
                value={form.weight_slab}
                onChange={e => setForm(f => ({ ...f, weight_slab: e.target.value }))}
                className="w-full text-xs border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary bg-surface"
              >
                <option value="">— select —</option>
                {WEIGHT_SLABS.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-secondary mb-1">COGS (₹ / Unit)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.cogs}
                onChange={e => setForm(f => ({ ...f, cogs: e.target.value }))}
                placeholder="Optional"
                className="w-full text-xs border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary bg-surface"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-secondary mb-1">Product Name</label>
              <input
                type="text"
                value={form.product_name}
                onChange={e => setForm(f => ({ ...f, product_name: e.target.value }))}
                placeholder="Optional description"
                className="w-full text-xs border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary bg-surface"
              />
            </div>
          </div>

          {error && <p className="text-xs text-rose-600 bg-rose-50 p-2 rounded-lg">✗ {error}</p>}

          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-secondary hover:text-ink border border-border rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-xs font-bold text-white bg-primary hover:bg-primary-hover rounded-lg shadow-sm disabled:opacity-50"
            >
              {saving ? 'Merging…' : 'Merge & Backfill Orders'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── TABLE: By VB EXPORT SKU (Consolidated Master Product View) ─────────────────
function VbSkuTable({ data = [], onEditSku }) {
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [expandedSku, setExpandedSku] = useState(null);
  const [sortBy, setSortBy] = useState('revenue');
  const [sortDir, setSortDir] = useState('desc');

  const categories = useMemo(() => {
    const cats = new Set();
    data.forEach(r => { if (r.category) cats.add(r.category); });
    return Array.from(cats).sort();
  }, [data]);

  const filtered = useMemo(() => {
    return data.filter(r => {
      if (categoryFilter !== 'all' && r.category !== categoryFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const matchSku = (r.vbExportSku || '').toLowerCase().includes(q);
        const matchCat = (r.category || '').toLowerCase().includes(q);
        const matchProd = (r.productName || '').toLowerCase().includes(q);
        const matchListing = (r.listingSkus || []).some(ls => String(ls).toLowerCase().includes(q));
        if (!matchSku && !matchCat && !matchProd && !matchListing) return false;
      }
      return true;
    }).sort((a, b) => {
      let valA = a[sortBy] ?? 0;
      let valB = b[sortBy] ?? 0;
      if (typeof valA === 'string') return sortDir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      return sortDir === 'asc' ? valA - valB : valB - valA;
    });
  }, [data, categoryFilter, search, sortBy, sortDir]);

  const tot = useMemo(() => {
    return filtered.reduce((acc, r) => ({
      units: acc.units + (+r.units || 0),
      orders: acc.orders + (+r.orders || 0),
      revenue: acc.revenue + (+r.revenue || 0),
      bankReceived: acc.bankReceived + (+r.bankReceived || 0),
      fkTotalFees: acc.fkTotalFees + (+r.fkTotalFees || 0),
      cogs: acc.cogs + (+r.cogs || 0),
      grossProfit: acc.grossProfit + (+r.grossProfit || 0),
      returns: acc.returns + (+r.returns || 0),
    }), { units: 0, orders: 0, revenue: 0, bankReceived: 0, fkTotalFees: 0, cogs: 0, grossProfit: 0, returns: 0 });
  }, [filtered]);

  const totMargin = tot.revenue > 0 ? ((tot.grossProfit / tot.revenue) * 100) : 0;
  const totReturnRate = tot.orders > 0 ? ((tot.returns / tot.orders) * 100) : 0;

  const handleSort = (field) => {
    if (sortBy === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(field); setSortDir('desc'); }
  };

  if (!data?.length) {
    return <div className="text-center text-outline py-12 text-sm">No VB EXPORT SKU data found for the selected period.</div>;
  }

  return (
    <div className="space-y-4">
      {/* Controls Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-1 max-w-xl">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search VB EXPORT SKU, Category, Listing SKU…"
            className="w-full text-xs border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary bg-surface font-mono"
          />
          {categories.length > 1 && (
            <select
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value)}
              className="text-xs border border-border rounded-lg px-3 py-2 bg-surface text-secondary focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="all">All Categories ({categories.length})</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-secondary self-end">
          <span className="font-semibold text-ink">{filtered.length.toLocaleString()}</span> VB SKUs
          {search && <span>(filtered from {data.length.toLocaleString()})</span>}
        </div>
      </div>

      {/* Main Table */}
      <div className="overflow-x-auto rounded-xl border border-border shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead className="bg-surface-container-low border-b border-border">
            <tr>
              <Th onClick={() => handleSort('vbExportSku')} sorted={sortBy==='vbExportSku'} sortDir={sortDir}>VB EXPORT SKU</Th>
              <Th onClick={() => handleSort('category')} sorted={sortBy==='category'} sortDir={sortDir}>Category</Th>
              <Th onClick={() => handleSort('weightSlab')} sorted={sortBy==='weightSlab'} sortDir={sortDir}>Weight Slab</Th>
              <Th onClick={() => handleSort('listingCount')} sorted={sortBy==='listingCount'} sortDir={sortDir} right>Listings</Th>
              <Th onClick={() => handleSort('units')} sorted={sortBy==='units'} sortDir={sortDir} right>Units</Th>
              <Th onClick={() => handleSort('revenue')} sorted={sortBy==='revenue'} sortDir={sortDir} right>Revenue</Th>
              <Th onClick={() => handleSort('bankReceived')} sorted={sortBy==='bankReceived'} sortDir={sortDir} right>Bank Recv.</Th>
              <Th onClick={() => handleSort('fkTotalFees')} sorted={sortBy==='fkTotalFees'} sortDir={sortDir} right>Fees</Th>
              <Th onClick={() => handleSort('cogs')} sorted={sortBy==='cogs'} sortDir={sortDir} right>COGS / Unit</Th>
              <Th onClick={() => handleSort('grossProfit')} sorted={sortBy==='grossProfit'} sortDir={sortDir} right>Gross Profit</Th>
              <Th onClick={() => handleSort('returnRate')} sorted={sortBy==='returnRate'} sortDir={sortDir} right>Ret. %</Th>
              <Th onClick={() => handleSort('marginPct')} sorted={sortBy==='marginPct'} sortDir={sortDir} right>Margin %</Th>
              <th className="px-3 py-2.5 text-[11px] text-right text-outline uppercase font-semibold">Config</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map(r => {
              const isExpanded = expandedSku === r.vbExportSku;
              return (
                <tr key={r.vbExportSku} className="hover:bg-surface-container-low transition-colors group">
                  <Td bold>
                    <div className="flex flex-col">
                      <span className="font-mono text-xs text-primary font-bold">{r.vbExportSku}</span>
                      {r.productName && <span className="text-[10px] text-secondary truncate max-w-[180px]">{r.productName}</span>}
                    </div>
                  </Td>
                  <Td>
                    <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-surface-container text-secondary">
                      {r.category || 'Uncategorized'}
                    </span>
                  </Td>
                  <Td>
                    <span className="font-mono text-[11px] text-secondary">
                      {fmtWeightSlab(r.weightSlab)}
                    </span>
                  </Td>
                  <Td right>
                    <button
                      onClick={() => setExpandedSku(isExpanded ? null : r.vbExportSku)}
                      className="px-2 py-0.5 rounded text-[10px] font-bold bg-primary-container text-primary hover:bg-primary hover:text-white transition-colors"
                      title="Click to view merged marketplace listing SKUs"
                    >
                      {r.listingCount || 1} listings {isExpanded ? '▲' : '▼'}
                    </button>
                  </Td>
                  <Td right>{fmt(r.units)}</Td>
                  <Td right bold>₹{fmt(r.revenue, 0)}</Td>
                  <Td right>₹{fmt(r.bankReceived, 0)}</Td>
                  <Td right color="text-amber-700">₹{fmt(r.fkTotalFees, 0)}</Td>
                  <Td right>
                    <div className="flex flex-col items-end">
                      <span className={r.hasCogs ? 'font-semibold text-orange-600' : 'text-amber-500 font-bold'}>
                        {r.hasCogs ? `₹${fmt(r.cogsPerUnit, 0)}` : '⚠️ Set COGS'}
                      </span>
                      {r.hasCogs && <span className="text-[10px] text-outline">tot: ₹{fmt(r.cogs, 0)}</span>}
                    </div>
                  </Td>
                  <GpCell value={r.grossProfit} />
                  <Td right color={+r.returnRate > 20 ? 'text-rose-600 font-bold' : 'text-secondary'}>
                    {pct(r.returnRate)}
                  </Td>
                  <MarginCell value={r.marginPct} />
                  <Td right>
                    <button
                      onClick={() => onEditSku(r)}
                      className="text-xs px-2.5 py-1 text-primary hover:text-white border border-primary/40 hover:bg-primary rounded-lg transition-colors font-medium"
                      title="Edit COGS and Weight Slab for this master SKU"
                    >
                      Edit ⚙
                    </button>
                  </Td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-surface-container font-bold border-t-2 border-border">
            <tr>
              <Td bold>Total ({filtered.length})</Td>
              <Td>—</Td>
              <Td>—</Td>
              <Td right>—</Td>
              <Td right bold>{fmt(tot.units)}</Td>
              <Td right bold>₹{fmt(tot.revenue, 0)}</Td>
              <Td right bold>₹{fmt(tot.bankReceived, 0)}</Td>
              <Td right bold color="text-amber-700">₹{fmt(tot.fkTotalFees, 0)}</Td>
              <Td right bold color="text-orange-600">₹{fmt(tot.cogs, 0)}</Td>
              <GpCell value={tot.grossProfit} />
              <Td right bold color={totReturnRate > 20 ? 'text-rose-600' : 'text-secondary'}>{pct(totReturnRate)}</Td>
              <MarginCell value={totMargin} />
              <Td right>—</Td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Expand Drawer / Modal for Listings under selected VB SKU */}
      {expandedSku && (
        <div className="bg-primary-container/20 border border-primary/30 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-primary">Marketplace Listings Merged into Master:</span>
              <span className="font-mono text-xs font-bold text-ink bg-surface px-2 py-0.5 rounded border border-border">{expandedSku}</span>
            </div>
            <button onClick={() => setExpandedSku(null)} className="text-secondary hover:text-ink text-xs font-bold">✕ Close</button>
          </div>
          <div className="flex flex-wrap gap-2">
            {(data.find(d => d.vbExportSku === expandedSku)?.listingSkus || []).map(ls => (
              <span key={ls} className="font-mono text-xs bg-surface border border-border px-2.5 py-1 rounded-lg text-ink shadow-xs">
                {ls}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── SECTION: Unmerged Listings (Trigger & System Alert) ──────────────────────
function UnmergedListingsSection({ onMerged }) {
  const [unmerged, setUnmerged] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState('');
  const [mpFilter, setMpFilter] = useState('all');
  const [mergeTarget, setMergeTarget] = useState(null);

  const loadUnmerged = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchUnmergedSkus();
      setUnmerged(res?.unmerged || []);
    } catch (e) {
      console.warn('[loadUnmerged]', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadUnmerged(); }, [loadUnmerged]);

  const filtered = useMemo(() => {
    return unmerged.filter(r => {
      if (mpFilter !== 'all' && (r.marketplace || '').toLowerCase() !== mpFilter.toLowerCase()) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!r.sku?.toLowerCase().includes(q) && !r.category?.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [unmerged, mpFilter, search]);

  const handleMergedSuccess = () => {
    loadUnmerged();
    if (onMerged) onMerged();
  };

  return (
    <div className="space-y-4">
      {/* Header Explainer */}
      <div className="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-5 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">⚡</span>
          <h3 className="text-sm font-bold text-amber-950">Marketplace Listing SKU Merge System</h3>
        </div>
        <p className="text-xs text-amber-800 leading-relaxed">
          When orders arrive from Flipkart, Amazon, Myntra, or Meesho, they use marketplace-specific listing SKUs.
          To track true profitability, COGS, and weight slabs, each marketplace listing must be merged into your master <strong>VB EXPORT SKU</strong>.
          Listings appearing below are in order history but not yet linked to a VB EXPORT SKU.
        </p>
      </div>

      {/* Filter Controls */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-1 max-w-md">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search unmerged listing SKU…"
            className="w-full text-xs border border-border rounded-lg px-3 py-2 bg-surface font-mono"
          />
          <select
            value={mpFilter}
            onChange={e => setMpFilter(e.target.value)}
            className="text-xs border border-border rounded-lg px-3 py-2 bg-surface text-secondary"
          >
            <option value="all">All Portals</option>
            <option value="flipkart">Flipkart</option>
            <option value="amazon">Amazon</option>
            <option value="myntra">Myntra</option>
            <option value="meesho">Meesho</option>
          </select>
        </div>
        <div className="text-xs text-secondary font-semibold">
          {filtered.length} unmerged listings found
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="py-12 text-center text-secondary text-xs">Scanning orders for unmerged listing SKUs…</div>
      ) : filtered.length === 0 ? (
        <div className="py-14 text-center bg-emerald-50 border border-emerald-200 rounded-2xl space-y-2">
          <div className="w-10 h-10 rounded-full bg-emerald-200 text-emerald-800 flex items-center justify-center mx-auto text-xl font-bold">✓</div>
          <h4 className="text-sm font-bold text-emerald-900">All Marketplace Listings are Merged!</h4>
          <p className="text-xs text-emerald-700">100% of order listing SKUs are successfully mapped to VB EXPORT SKUs.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="bg-surface-container-low border-b border-border text-secondary">
              <tr>
                <Th>Marketplace Listing SKU</Th>
                <Th>Portal</Th>
                <Th>Order Category</Th>
                <Th right>Orders</Th>
                <Th right>Revenue</Th>
                <Th>Suggested VB SKU</Th>
                <Th>First / Last Order</Th>
                <th className="px-4 py-2.5 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(r => {
                const suggested = suggestVbSku(r.sku);
                return (
                  <tr key={`${r.marketplace}-${r.sku}`} className="hover:bg-surface-container-low transition-colors">
                    <Td bold>
                      <span className="font-mono text-xs text-ink">{r.sku}</span>
                    </Td>
                    <Td>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold capitalize ${mpCls(r.marketplace)}`}>
                        {r.marketplace}
                      </span>
                    </Td>
                    <Td>{r.category || '—'}</Td>
                    <Td right bold>{fmt(r.order_count)}</Td>
                    <Td right className="text-emerald-700 font-semibold">₹{fmt(r.total_revenue, 0)}</Td>
                    <Td>
                      <span className="font-mono text-[11px] text-primary font-semibold">
                        {suggested}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-[10px] text-outline">
                        {r.first_seen?.slice(0, 10)} → {r.last_seen?.slice(0, 10)}
                      </span>
                    </Td>
                    <Td right>
                      <button
                        onClick={() => setMergeTarget(r)}
                        className="px-3 py-1 text-xs font-bold text-white bg-primary hover:bg-primary-hover rounded-lg shadow-xs transition-colors"
                      >
                        Merge Now →
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Merge Modal */}
      {mergeTarget && (
        <MergeSkuModal
          listingItem={mergeTarget}
          onClose={() => setMergeTarget(null)}
          onMerged={handleMergedSuccess}
        />
      )}
    </div>
  );
}

// ── SKU Master & COGS — config panel (admin/owner use) ────────────────────────
function SkuMasterSection({ onUpdated, initialSubTab = 'vb_catalog', unmergedCount = 0 }) {
  const fileRef = useRef();
  const [activeSubTab, setActiveSubTab] = useState(initialSubTab); // 'vb_catalog' | 'listings' | 'unmerged'
  const [skuData, setSkuData]   = useState(null);
  const [vbData, setVbData]     = useState(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [uploadError, setUploadError]   = useState(null);
  const [page, setPage]   = useState(1);
  const [search, setSearch] = useState('');
  const [dragging, setDragging] = useState(false);
  const [adding, setAdding]     = useState(false);
  const [addForm, setAddForm]   = useState({ master_sku: '', marketplace: 'all', listing_sku: '', cogs: '', launch_date: '', product_name: '', weight_slab: '', category: '' });
  const [addErr, setAddErr]     = useState(null);
  const [editingVbSku, setEditingVbSku] = useState(null);

  useEffect(() => {
    if (initialSubTab) setActiveSubTab(initialSubTab);
  }, [initialSubTab]);

  const loadRows = useCallback(async () => {
    if (activeSubTab === 'unmerged') return;
    setLoadingRows(true);
    try {
      if (activeSubTab === 'vb_catalog') {
        const res = await fetchVbExportSkus({ search: search || undefined, page });
        setVbData(res);
      } else if (activeSubTab === 'listings') {
        const res = await fetchSkuMaster(undefined, search || undefined, page);
        setSkuData(res);
      }
    } catch { /* ignore */ }
    setLoadingRows(false);
  }, [activeSubTab, search, page]);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  const handleFile = async (f) => {
    if (!f) return;
    setUploading(true); setUploadError(null); setUploadResult(null);
    try {
      const fd = new FormData(); fd.append('file', f);
      const r = await uploadSkuMasterFile(fd);
      setUploadResult(r);
      loadRows();
      if (onUpdated) onUpdated();
    } catch (e) { setUploadError(e?.response?.data?.error || e.message); }
    setUploading(false);
  };

  const handleAdd = async () => {
    if (!addForm.listing_sku.trim()) { setAddErr('Listing SKU required'); return; }
    setAddErr(null);
    try {
      await addSkuMasterRow(addForm);
      setAdding(false);
      setAddForm({ master_sku: '', marketplace: 'all', listing_sku: '', cogs: '', launch_date: '', product_name: '', weight_slab: '', category: '' });
      loadRows();
      if (onUpdated) onUpdated();
    } catch (e) { setAddErr(e?.response?.data?.error || e.message); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Remove this SKU mapping?')) return;
    try {
      await deleteSkuMasterRow(id);
      loadRows();
      if (onUpdated) onUpdated();
    } catch (e) { alert(e?.response?.data?.error || e.message); }
  };

  const downloadTemplate = async () => {
    try {
      const blob = await downloadVbExportPrefilledTemplate();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'VB_Export_Product_Catalog_Prefilled.xlsx';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (e) {
      console.error('Failed to download prefilled template:', e);
      alert('Failed to download template. Please try again.');
    }
  };

  const rows = activeSubTab === 'vb_catalog' ? (vbData?.data || []) : (skuData?.data || []);
  const total = activeSubTab === 'vb_catalog' ? (vbData?.total || 0) : (skuData?.total || 0);
  const totalPages = Math.ceil(total / 100);

  return (
    <div className="space-y-4">
      {/* Sub-header & Tabs */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2 p-1 bg-surface-container rounded-xl">
          <button
            onClick={() => { setActiveSubTab('vb_catalog'); setPage(1); }}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeSubTab === 'vb_catalog' ? 'bg-surface text-ink shadow-sm' : 'text-secondary hover:text-ink'
            }`}
          >
            VB EXPORT SKUs (Master Catalog)
          </button>
          <button
            onClick={() => { setActiveSubTab('listings'); setPage(1); }}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeSubTab === 'listings' ? 'bg-surface text-ink shadow-sm' : 'text-secondary hover:text-ink'
            }`}
          >
            Marketplace SKU Mappings
          </button>
          <button
            onClick={() => { setActiveSubTab('unmerged'); setPage(1); }}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
              activeSubTab === 'unmerged' ? 'bg-surface text-ink shadow-sm' : 'text-secondary hover:text-ink'
            }`}
          >
            <span>Unmerged Listings (Trigger)</span>
            {unmergedCount > 0 && (
              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-white">
                {unmergedCount}
              </span>
            )}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={downloadTemplate}
            className="flex items-center gap-1.5 text-xs text-secondary hover:text-ink border border-border rounded-lg px-3 py-1.5 bg-surface hover:border-border transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            Excel Template
          </button>
        </div>
      </div>

      {/* Upload zone (only shown on catalog & listing tabs) */}
      {activeSubTab !== 'unmerged' && (
        <>
          <div
            className={`border-2 border-dashed rounded-xl flex flex-col items-center justify-center gap-2 py-5 cursor-pointer transition-colors ${
              dragging ? 'border-primary bg-primary-container' : 'border-border hover:border-primary hover:bg-indigo-50/20'
            }`}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); }}
            onClick={() => fileRef.current?.click()}
          >
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
              onChange={e => handleFile(e.target.files[0])} />
            {uploading ? (
              <><svg className="w-6 h-6 text-primary animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/></svg>
              <p className="text-sm font-semibold text-primary">Syncing VB Export Catalog into Database…</p></>
            ) : (
              <><svg className="w-6 h-6 text-outline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" /></svg>
              <div className="text-center">
                <p className="text-xs text-secondary font-medium">Drop <strong>VB EXPORT Product Category.xlsx</strong> or SKU Master file here, or click to browse</p>
                <p className="text-[11px] text-outline mt-0.5">Auto-detects VB Export catalog columns, updates master catalog, and backfills order history.</p>
              </div></>
            )}
          </div>

          {uploadResult && (
            <div className="flex items-center gap-4 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs">
              <span className="text-emerald-600 text-lg">✓</span>
              <span><strong className="text-emerald-700">{uploadResult.uniqueVbSkus || uploadResult.inserted}</strong> VB SKUs</span>
              <span><strong className="text-primary">{uploadResult.uniqueListings || uploadResult.updated}</strong> Listings Synced</span>
              {uploadResult.ordersBackfilled > 0 && <span><strong className="text-indigo-700">{uploadResult.ordersBackfilled.toLocaleString()}</strong> Orders Backfilled</span>}
            </div>
          )}
          {uploadError && <p className="text-xs text-rose-600 font-medium">✗ {uploadError}</p>}
        </>
      )}

      {/* ── Sub-tab 1: VB EXPORT SKUs Catalog ── */}
      {activeSubTab === 'vb_catalog' && (
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 bg-surface-container-low border-b border-border">
            <div className="flex items-center gap-3">
              <span className="text-xs font-bold text-ink">{total.toLocaleString()} Master VB SKUs</span>
              <input
                type="text"
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(1); }}
                placeholder="Search VB EXPORT SKU…"
                className="text-xs border border-border rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary w-48 bg-surface font-mono"
              />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-surface-container-low border-b border-border text-secondary">
                  <th className="text-left px-4 py-2.5 font-semibold">VB EXPORT SKU</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Category</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Weight Slab</th>
                  <th className="text-left px-4 py-2.5 font-semibold">COGS (₹ / Unit)</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Product Name</th>
                  <th className="text-right px-4 py-2.5 font-semibold">Mapped Listings</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {loadingRows ? (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-outline">Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-outline">No VB EXPORT SKUs found</td></tr>
                ) : rows.map(r => (
                  <tr key={r.vb_export_sku} className="hover:bg-surface-container-low transition-colors">
                    <td className="px-4 py-2.5 font-mono font-bold text-primary">{r.vb_export_sku}</td>
                    <td className="px-4 py-2.5 text-secondary">{r.category || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-secondary">{fmtWeightSlab(r.weight_slab)}</td>
                    <td className="px-4 py-2.5 font-bold text-orange-600">
                      {+r.cogs > 0 ? `₹${(+r.cogs).toFixed(2)}` : <span className="text-amber-500 font-normal">⚠️ Not set</span>}
                    </td>
                    <td className="px-4 py-2.5 text-secondary truncate max-w-[200px]">{r.product_name || '—'}</td>
                    <td className="px-4 py-2.5 text-right font-semibold text-ink">{r.listings_count || 1}</td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => setEditingVbSku({
                          vbExportSku: r.vb_export_sku,
                          category: r.category,
                          weightSlab: r.weight_slab,
                          cogs: r.cogs,
                          productName: r.product_name,
                          listingCount: r.listings_count,
                        })}
                        className="px-2.5 py-1 text-xs text-primary hover:bg-primary-container rounded-lg font-semibold"
                      >
                        Edit ⚙
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-border bg-surface-container-low/40">
              <span className="text-[11px] text-outline">{(page-1)*100+1}–{Math.min(page*100, total)} of {total.toLocaleString()}</span>
              <div className="flex gap-2">
                <button disabled={page <= 1} onClick={() => setPage(p => p-1)} className="text-xs px-2.5 py-1 border border-border rounded-lg disabled:opacity-40 hover:bg-surface-container">← Prev</button>
                <button disabled={page >= totalPages} onClick={() => setPage(p => p+1)} className="text-xs px-2.5 py-1 border border-border rounded-lg disabled:opacity-40 hover:bg-surface-container">Next →</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Sub-tab 2: Marketplace Listings Mappings ── */}
      {activeSubTab === 'listings' && (
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 bg-surface-container-low border-b border-border">
            <div className="flex items-center gap-3">
              <span className="text-xs font-bold text-ink">{total.toLocaleString()} mappings</span>
              <input
                type="text"
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(1); }}
                placeholder="Search Listing SKU or Master SKU…"
                className="text-xs border border-border rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary w-52 bg-surface font-mono"
              />
            </div>
            <button onClick={() => { setAdding(true); setAddErr(null); }}
              className="flex items-center gap-1.5 text-xs font-semibold text-white bg-primary hover:bg-primary rounded-lg px-3 py-1.5 transition-colors">
              + Add Mapping
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-surface-container-low border-b border-border text-secondary">
                  <th className="text-left px-4 py-2.5 font-semibold">Listing SKU</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Master VB SKU</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Marketplace</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Category</th>
                  <th className="text-left px-4 py-2.5 font-semibold">COGS (₹)</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Weight Slab</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {adding && (
                  <tr className="bg-indigo-50/40">
                    <td className="px-3 py-2"><input autoFocus value={addForm.listing_sku} onChange={e => setAddForm(f => ({...f, listing_sku: e.target.value}))} placeholder="Listing SKU *" className="w-full text-xs border border-primary rounded-lg px-2 py-1 font-mono" /></td>
                    <td className="px-3 py-2"><input value={addForm.master_sku} onChange={e => setAddForm(f => ({...f, master_sku: e.target.value}))} placeholder="VB EXPORT SKU" className="w-full text-xs border border-border rounded-lg px-2 py-1 font-mono" /></td>
                    <td className="px-3 py-2">
                      <select value={addForm.marketplace} onChange={e => setAddForm(f => ({...f, marketplace: e.target.value}))} className="text-xs border border-border rounded-lg px-2 py-1 bg-surface">
                        {['all','flipkart','amazon','myntra','meesho'].map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2"><input value={addForm.category} onChange={e => setAddForm(f => ({...f, category: e.target.value}))} placeholder="Category" className="w-full text-xs border border-border rounded-lg px-2 py-1" /></td>
                    <td className="px-3 py-2"><input type="number" value={addForm.cogs} onChange={e => setAddForm(f => ({...f, cogs: e.target.value}))} placeholder="0" className="w-20 text-xs border border-border rounded-lg px-2 py-1 text-right" /></td>
                    <td className="px-3 py-2">
                      <select value={addForm.weight_slab} onChange={e => setAddForm(f => ({...f, weight_slab: e.target.value}))} className="text-xs border border-border rounded-lg px-2 py-1 bg-surface w-24">
                        <option value="">—</option>
                        {WEIGHT_SLABS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex gap-1.5 justify-end">
                        <button onClick={handleAdd} className="text-[10px] font-bold text-white bg-primary hover:bg-primary px-2.5 py-1 rounded-lg">Save</button>
                        <button onClick={() => setAdding(false)} className="text-[10px] text-outline px-2.5 py-1 rounded-lg border border-border">Cancel</button>
                      </div>
                      {addErr && <p className="text-[10px] text-rose-600 mt-0.5">{addErr}</p>}
                    </td>
                  </tr>
                )}
                {loadingRows ? (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-outline">Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-outline">No mappings found</td></tr>
                ) : rows.map(r => (
                  <tr key={r.id} className="hover:bg-surface-container-low transition-colors">
                    <td className="px-4 py-2.5 font-mono text-ink font-semibold">{r.listing_sku}</td>
                    <td className="px-4 py-2.5 font-mono text-primary font-bold">{r.master_sku}</td>
                    <td className="px-4 py-2.5"><span className={`px-2 py-0.5 rounded text-[10px] font-bold capitalize ${mpCls(r.marketplace)}`}>{r.marketplace}</span></td>
                    <td className="px-4 py-2.5 text-secondary">{r.category || '—'}</td>
                    <td className="px-4 py-2.5 font-bold text-emerald-700">₹{(+r.cogs).toLocaleString('en-IN')}</td>
                    <td className="px-4 py-2.5 text-secondary font-mono text-[11px]">{fmtWeightSlab(r.weight_slab)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <button onClick={() => handleDelete(r.id)} className="text-outline hover:text-rose-600 p-1">
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-border bg-surface-container-low/40">
              <span className="text-[11px] text-outline">{(page-1)*100+1}–{Math.min(page*100, total)} of {total.toLocaleString()}</span>
              <div className="flex gap-2">
                <button disabled={page <= 1} onClick={() => setPage(p => p-1)} className="text-xs px-2.5 py-1 border border-border rounded-lg disabled:opacity-40 hover:bg-surface-container">← Prev</button>
                <button disabled={page >= totalPages} onClick={() => setPage(p => p+1)} className="text-xs px-2.5 py-1 border border-border rounded-lg disabled:opacity-40 hover:bg-surface-container">Next →</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Sub-tab 3: Unmerged Listings (Trigger) ── */}
      {activeSubTab === 'unmerged' && (
        <UnmergedListingsSection onMerged={() => {
          loadRows();
          if (onUpdated) onUpdated();
        }} />
      )}

      {/* Edit VB SKU Modal */}
      {editingVbSku && (
        <VbSkuEditModal
          skuItem={editingVbSku}
          onClose={() => setEditingVbSku(null)}
          onSaved={() => {
            loadRows();
            if (onUpdated) onUpdated();
          }}
        />
      )}
    </div>
  );
}

// ── MAIN PROFIT ANALYSIS PAGE ──────────────────────────────────────────────────
export default function ProfitAnalysisPage() {
  const { filters, refreshKey } = useFilters();
  const [tab,           setTab]           = useState('overview');
  const [skuViewMode,   setSkuViewMode]   = useState('vb_master'); // 'vb_master' | 'listing_sku'
  const [cogsSubTab,    setCogsSubTab]    = useState('vb_catalog'); // 'vb_catalog' | 'listings' | 'unmerged'
  const [sellerAccount, setSellerAccount] = useState('all');
  const [editingVbSku,  setEditingVbSku]  = useState(null);

  const reportFilters = useMemo(
    () => ({ ...filters, _refresh: refreshKey || undefined }),
    [filters, refreshKey],
  );
  const reportDeps = [
    reportFilters.startDate, reportFilters.endDate, reportFilters.category,
    reportFilters.region, reportFilters.status, reportFilters.groupBy,
    reportFilters.marketplace, reportFilters.brand, sellerAccount, refreshKey,
  ];

  const { data, loading, error, refetch } = useFetch(
    () => fetchProfitAnalysis(reportFilters, sellerAccount === 'all' ? null : sellerAccount),
    reportDeps,
    { enabled: tab !== 'cogsconfig' },
  );

  const s = data?.summary;
  const hasCogs = s?.cogsConfigured;
  const unmergedCount = data?.unmergedSummary?.unmergedSkuCount || 0;

  // Build account selector options from byAccount data
  const accounts = data?.byAccount?.map(r => r.sellerAccount) || [];
  const showAccountFilter = accounts.length > 1;

  const tabs = [
    { key: 'overview',   label: 'Overview' },
    { key: 'category',   label: 'By Category' },
    { key: 'sku',        label: 'By SKU' },
    { key: 'account',    label: 'By Account' },
    { key: 'zone',       label: 'By Zone' },
    { key: 'cogsconfig', label: 'COGS & Weight Slabs', badge: unmergedCount > 0 ? unmergedCount : undefined },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink">Profit & Unit Economics Analysis</h1>
          <p className="text-sm text-secondary mt-0.5">
            Master SKU profit tracking centered on <strong>VB EXPORT SKUs</strong>, COGS, weight slabs, and multi-portal settlements.
          </p>
        </div>
        {showAccountFilter && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-secondary font-medium">Account:</span>
            <select
              value={sellerAccount}
              onChange={e => setSellerAccount(e.target.value)}
              className="border border-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="all">All Accounts</option>
              {accounts.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* ── UNMERGED SKU TRIGGER ALERT BANNER ── */}
      {unmergedCount > 0 && (
        <div className="bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-amber-500/10 border-2 border-amber-400/60 rounded-2xl p-4 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 animate-in fade-in">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500 text-white flex items-center justify-center font-bold text-lg shadow-sm shrink-0">
              ⚠️
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-ink">Marketplace Listing SKUs Not Merged with VB EXPORT SKU</h3>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-200 text-amber-900 animate-pulse">Action Required</span>
              </div>
              <p className="text-xs text-secondary mt-0.5">
                <strong className="text-ink font-bold">{unmergedCount}</strong> marketplace listing SKUs ({data.unmergedSummary.unmergedOrderCount?.toLocaleString()} orders, {fmtK(data.unmergedSummary.unmergedRevenue)} revenue) are not yet merged with a VB EXPORT SKU.
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              setTab('cogsconfig');
              setCogsSubTab('unmerged');
            }}
            className="px-4 py-2 text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 rounded-xl shadow-sm transition-all shrink-0"
          >
            Review & Merge Listings ({unmergedCount}) →
          </button>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="flex items-center justify-between gap-3 bg-rose-50 border border-rose-200 rounded-2xl px-5 py-3 text-rose-700 text-sm">
          <span>{data ? `Showing the last verified profitability report. ${error}` : error}</span>
          <button onClick={refetch} className="shrink-0 rounded-lg border border-rose-200 bg-surface px-3 py-1.5 text-xs font-bold text-rose-700">Retry</button>
        </div>
      )}

      {loading && data && (
        <div className="rounded-xl border border-border bg-surface-container-low px-4 py-2 text-center text-xs font-semibold text-secondary">
          Refreshing profitability report…
        </div>
      )}

      {/* KPI Cards */}
      {loading && !data ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array(6).fill(0).map((_, i) => (
            <div key={i} className="rounded-xl border border-border px-5 py-4 animate-pulse bg-surface-container h-24" />
          ))}
        </div>
      ) : s && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <KpiCard label="Gross Revenue"   value={fmtK(s.grossRevenue)}  sub={`${fmt(s.totalOrders)} orders`}                         color="indigo"  icon="📦" />
          <KpiCard label="Bank Received"   value={fmtK(s.bankReceived)}  sub={`After refunds: −${fmtK(s.totalRefunds)}`}               color="slate"   icon="🏦" />
          <KpiCard label="Marketplace Fees" value={fmtK(s.fkTotalFees)}  sub={s.grossRevenue > 0 ? `${((s.fkTotalFees/s.grossRevenue)*100).toFixed(1)}% of revenue` : ''}  color="amber"   icon="💸" />
          <KpiCard label="Total COGS"      value={hasCogs ? fmtK(s.totalCogs) : '—'} sub={hasCogs ? (s.grossRevenue > 0 ? `${((s.totalCogs/s.grossRevenue)*100).toFixed(1)}% of revenue` : '') : 'Upload SKU master'} color={hasCogs ? "slate" : "amber"} icon="🏭" />
          <KpiCard label="Gross Profit"    value={fmtK(s.grossProfit)}   sub={`After all deductions`}                                   color={s.grossProfit >= 0 ? 'emerald' : 'rose'} icon="💰" trend={s.profitMarginPct} />
          <KpiCard label="Returns"         value={fmt(s.returnCount)}    sub={`${pct(s.returnRate)} return rate`}                       color={s.returnRate > 20 ? 'rose' : 'slate'} icon="↩️" />
        </div>
      )}

      {/* Main Container with Tabs */}
      <div className="bg-surface rounded-xl border border-border shadow-sm">
        <div className="flex items-center gap-1 px-4 pt-4 pb-0 border-b border-border overflow-x-auto">
          {tabs.map(t => (
            <Tab key={t.key} label={t.label} active={tab === t.key} onClick={() => setTab(t.key)} badge={t.badge} />
          ))}
        </div>

        <div className="p-6">
          {loading && !data ? (
            <div className="flex items-center justify-center py-16">
              <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* ── 1. Overview ── */}
              {tab === 'overview' && (
                <div className="space-y-8">
                  <div>
                    <p className="text-sm font-semibold text-ink mb-4">Trend — Revenue / Fees / COGS / Gross Profit</p>
                    <TrendChart data={data?.trend} />
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <div>
                      <p className="text-sm font-semibold text-ink mb-4">Profit Waterfall</p>
                      <ProfitFlow s={s} />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-ink mb-4">Marketplace Fee Breakdown</p>
                      <FeePie fees={s?.fees} total={s?.fkTotalFees} />
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-semibold text-outline uppercase tracking-wider mb-2">Marketplace Fee Details</p>
                    <FeeRow fees={s?.fees} />
                  </div>
                </div>
              )}

              {/* ── 2. By Category (Consolidated by VB Export Category) ── */}
              {tab === 'category' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-base font-bold text-ink">Category-wise Profit Breakdown</h2>
                      <p className="text-xs text-secondary mt-0.5">
                        Consolidated by VB Export Product Category across all sales channels and marketplaces.
                      </p>
                    </div>
                  </div>
                  <CategoryTable data={data?.byCategory} />
                </div>
              )}

              {/* ── 3. By SKU (Defaults to Master VB EXPORT SKU with Listing SKU toggle) ── */}
              {tab === 'sku' && (
                <div className="space-y-4">
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                    <div>
                      <h2 className="text-base font-bold text-ink">
                        {skuViewMode === 'vb_master' ? 'Master Product Profitability (VB EXPORT SKU)' : 'Top 30 Marketplace Listing SKUs by Revenue'}
                      </h2>
                      <p className="text-xs text-secondary mt-0.5">
                        {skuViewMode === 'vb_master'
                          ? 'Consolidated revenue, fees, COGS, and gross profit by master VB EXPORT SKU. Click any row to expand merged marketplace listings.'
                          : 'Individual marketplace listing SKUs ranked by revenue with fees and unit economics.'}
                      </p>
                    </div>

                    <div className="flex items-center gap-1 p-1 bg-surface-container rounded-xl shrink-0">
                      <button
                        onClick={() => setSkuViewMode('vb_master')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                          skuViewMode === 'vb_master' ? 'bg-surface text-ink shadow-sm' : 'text-secondary hover:text-ink'
                        }`}
                      >
                        <span>⭐ Master SKU (VB EXPORT)</span>
                      </button>
                      <button
                        onClick={() => setSkuViewMode('listing_sku')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                          skuViewMode === 'listing_sku' ? 'bg-surface text-ink shadow-sm' : 'text-secondary hover:text-ink'
                        }`}
                      >
                        <span>Listing SKUs</span>
                      </button>
                    </div>
                  </div>

                  {skuViewMode === 'vb_master' ? (
                    <VbSkuTable
                      data={data?.byVbSku || []}
                      onEditSku={(skuItem) => setEditingVbSku(skuItem)}
                    />
                  ) : (
                    <SkuTable data={data?.bySkuTop} />
                  )}
                </div>
              )}

              {/* ── 4. By Account ── */}
              {tab === 'account' && (
                <div className="space-y-4">
                  <p className="text-sm font-semibold text-ink">Account / Brand Comparison</p>
                  <AccountTable data={data?.byAccount} />
                </div>
              )}

              {/* ── 5. By Zone ── */}
              {tab === 'zone' && (
                <div className="space-y-4">
                  <p className="text-sm font-semibold text-ink">Zone-wise Profit Breakdown</p>
                  <ZoneTable data={data?.byZone} />
                </div>
              )}

              {/* ── 6. COGS & Weight Slabs Master Config ── */}
              {tab === 'cogsconfig' && (
                <SkuMasterSection
                  onUpdated={refetch}
                  initialSubTab={cogsSubTab}
                  unmergedCount={unmergedCount}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* Edit VB SKU Modal from VbSkuTable */}
      {editingVbSku && (
        <VbSkuEditModal
          skuItem={editingVbSku}
          onClose={() => setEditingVbSku(null)}
          onSaved={refetch}
        />
      )}
    </div>
  );
}

// ── Tables from previous version ───────────────────────────────────────────────
function CategoryTable({ data }) {
  if (!data?.length) return <div className="text-center text-outline py-12 text-sm">No data</div>;
  const tot = data.reduce((a, r) => ({
    orders:      a.orders      + (+r.orders      || 0),
    returns:     a.returns     + (+r.returns      || 0),
    revenue:     a.revenue     + (+r.revenue      || 0),
    bankReceived:a.bankReceived+ (+r.bankReceived  || 0),
    cogs:        a.cogs        + (+r.cogs          || 0),
    fkTotalFees: a.fkTotalFees + (+r.fkTotalFees   || 0),
    grossProfit: a.grossProfit + (+r.grossProfit    || 0),
  }), { orders:0, returns:0, revenue:0, bankReceived:0, cogs:0, fkTotalFees:0, grossProfit:0 });
  const totMargin = tot.revenue > 0 ? ((tot.grossProfit / tot.revenue) * 100) : 0;

  return (
    <div className="overflow-x-auto rounded-xl border border-border shadow-sm">
      <table className="w-full min-w-[920px] text-left border-collapse">
        <thead className="bg-surface-container-low border-b border-border">
          <tr>
            <Th>Category</Th>
            <Th right>Orders</Th>
            <Th right>Returns</Th>
            <Th right>Return %</Th>
            <Th right>Revenue</Th>
            <Th right>Bank Recv.</Th>
            <Th right>Fees</Th>
            <Th right>COGS</Th>
            <Th right>Gross Profit</Th>
            <Th right>Margin %</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.map(r => {
            const margin = +r.revenue > 0 ? ((+r.grossProfit / +r.revenue) * 100) : 0;
            return (
              <tr key={r.category} className="group hover:bg-primary-container/30 transition-colors">
                <Td bold>
                  <span className={`inline-flex items-center rounded-full border px-2 py-1 text-[11px] font-semibold ${categoryTone(r.category)}`}>
                    {r.category || 'Uncategorized'}
                  </span>
                </Td>
                <Td right bold color="text-slate-700">{fmt(r.orders)}</Td>
                <Td right bold color="text-rose-600">{fmt(r.returns)}</Td>
                <Td right color={+r.returnRate > 20 ? 'text-rose-600' : 'text-secondary'}>{pct(r.returnRate)}</Td>
                <Td right bold color="text-primary">₹{fmt(r.revenue, 0)}</Td>
                <Td right bold color="text-emerald-700">₹{fmt(r.bankReceived, 0)}</Td>
                <Td right color="text-amber-700">₹{fmt(r.fkTotalFees, 0)}</Td>
                <Td right color="text-orange-600">₹{fmt(r.cogs, 0)}</Td>
                <GpCell value={r.grossProfit} />
                <MarginCell value={margin} />
              </tr>
            );
          })}
        </tbody>
        <tfoot className="bg-surface-container border-t-2 border-border">
          <tr>
            <Td bold><span className="text-ink">Total</span></Td>
            <Td right bold color="text-slate-800">{fmt(tot.orders)}</Td>
            <Td right bold color="text-rose-700">{fmt(tot.returns)}</Td>
            <Td right bold>{tot.orders > 0 ? pct((tot.returns/tot.orders)*100) : '—'}</Td>
            <Td right bold color="text-primary">₹{fmt(tot.revenue, 0)}</Td>
            <Td right bold color="text-emerald-700">₹{fmt(tot.bankReceived, 0)}</Td>
            <Td right bold color="text-amber-700">₹{fmt(tot.fkTotalFees, 0)}</Td>
            <Td right bold color="text-orange-600">₹{fmt(tot.cogs, 0)}</Td>
            <GpCell value={tot.grossProfit} />
            <MarginCell value={totMargin} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function SkuTable({ data }) {
  const [search, setSearch] = useState('');
  if (!data?.length) return <div className="text-center text-outline py-12 text-sm">No data</div>;

  const filtered = search
    ? data.filter(r => (r.sku + r.masterSku + r.category).toLowerCase().includes(search.toLowerCase()))
    : data;

  return (
    <div className="space-y-3">
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search SKU / Master SKU / category…"
        className="w-full max-w-sm border border-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
      />
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-left border-collapse">
          <thead className="bg-surface-container-low border-b border-border">
            <tr>
              <Th>Listing SKU</Th>
              <Th>Master VB SKU</Th>
              <Th>Category</Th>
              <Th right>Units</Th>
              <Th right>Revenue</Th>
              <Th right>Bank Recv.</Th>
              <Th right>Fees</Th>
              <Th right>COGS / Unit</Th>
              <Th right>Ret. %</Th>
              <Th right>Gross Profit</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map(r => (
              <tr key={r.sku} className={`hover:bg-surface-container-low transition-colors ${!r.hasCogs ? 'opacity-70' : ''}`}>
                <Td>
                  <span className="font-mono text-[11px]">{r.sku}</span>
                  {!r.hasCogs && (
                    <span title="No COGS data" className="ml-1 text-amber-500 cursor-help">⚠️</span>
                  )}
                </Td>
                <Td><span className="font-mono text-[11px] text-primary font-bold">{r.masterSku === r.sku ? '—' : r.masterSku}</span></Td>
                <Td>{r.category}</Td>
                <Td right>{fmt(r.units)}</Td>
                <Td right>₹{fmt(r.revenue, 0)}</Td>
                <Td right>₹{fmt(r.bankReceived, 0)}</Td>
                <Td right color="text-amber-700">₹{fmt(r.fkTotalFees, 0)}</Td>
                <Td right color="text-orange-600">{r.hasCogs ? `₹${fmt(r.cogsPerUnit, 0)}` : <span className="text-outline">—</span>}</Td>
                <Td right color={+r.returnRate > 20 ? 'text-rose-600' : 'text-secondary'}>{pct(r.returnRate)}</Td>
                <GpCell value={r.grossProfit} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AccountTable({ data }) {
  if (!data?.length) return <div className="text-center text-outline py-12 text-sm">No data</div>;
  const tot = data.reduce((a, r) => ({
    orders:      a.orders      + (+r.orders      || 0),
    returns:     a.returns     + (+r.returns      || 0),
    revenue:     a.revenue     + (+r.revenue      || 0),
    bankReceived:a.bankReceived+ (+r.bankReceived  || 0),
    cogs:        a.cogs        + (+r.cogs          || 0),
    fkTotalFees: a.fkTotalFees + (+r.fkTotalFees   || 0),
    grossProfit: a.grossProfit + (+r.grossProfit    || 0),
  }), { orders:0, returns:0, revenue:0, bankReceived:0, cogs:0, fkTotalFees:0, grossProfit:0 });

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-left border-collapse">
        <thead className="bg-surface-container-low border-b border-border">
          <tr>
            <Th>Account / Brand</Th>
            <Th right>Orders</Th>
            <Th right>Returns</Th>
            <Th right>Return %</Th>
            <Th right>Revenue</Th>
            <Th right>Bank Recv.</Th>
            <Th right>Fees</Th>
            <Th right>COGS</Th>
            <Th right>Gross Profit</Th>
            <Th right>Margin %</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.map(r => {
            const margin = +r.revenue > 0 ? ((+r.grossProfit / +r.revenue) * 100) : 0;
            return (
              <tr key={r.sellerAccount} className="hover:bg-surface-container-low transition-colors">
                <Td bold>{r.sellerAccount}</Td>
                <Td right>{fmt(r.orders)}</Td>
                <Td right>{fmt(r.returns)}</Td>
                <Td right color={+r.returnRate > 20 ? 'text-rose-600' : 'text-secondary'}>{pct(r.returnRate)}</Td>
                <Td right>₹{fmt(r.revenue, 0)}</Td>
                <Td right>₹{fmt(r.bankReceived, 0)}</Td>
                <Td right color="text-amber-700">₹{fmt(r.fkTotalFees, 0)}</Td>
                <Td right color="text-orange-600">₹{fmt(r.cogs, 0)}</Td>
                <GpCell value={r.grossProfit} />
                <MarginCell value={margin} />
              </tr>
            );
          })}
        </tbody>
        {data.length > 1 && (
          <tfoot className="bg-surface-container border-t-2 border-border">
            <tr>
              <Td bold>Total</Td>
              <Td right bold>{fmt(tot.orders)}</Td>
              <Td right bold>{fmt(tot.returns)}</Td>
              <Td right bold>{tot.orders > 0 ? pct((tot.returns/tot.orders)*100) : '—'}</Td>
              <Td right bold>₹{fmt(tot.revenue, 0)}</Td>
              <Td right bold>₹{fmt(tot.bankReceived, 0)}</Td>
              <Td right bold color="text-amber-700">₹{fmt(tot.fkTotalFees, 0)}</Td>
              <Td right bold color="text-orange-600">₹{fmt(tot.cogs, 0)}</Td>
              <GpCell value={tot.grossProfit} />
              <MarginCell value={tot.revenue > 0 ? (tot.grossProfit/tot.revenue)*100 : 0} />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function ZoneTable({ data }) {
  if (!data?.length) return <div className="text-center text-outline py-12 text-sm">No data</div>;
  const tot = data.reduce((a, r) => ({
    orders:      a.orders      + (+r.orders      || 0),
    returns:     a.returns     + (+r.returns      || 0),
    revenue:     a.revenue     + (+r.revenue      || 0),
    bankReceived:a.bankReceived+ (+r.bankReceived  || 0),
    cogs:        a.cogs        + (+r.cogs          || 0),
    fkTotalFees: a.fkTotalFees + (+r.fkTotalFees   || 0),
    grossProfit: a.grossProfit + (+r.grossProfit    || 0),
  }), { orders:0, returns:0, revenue:0, bankReceived:0, cogs:0, fkTotalFees:0, grossProfit:0 });
  const totMargin = tot.revenue > 0 ? ((tot.grossProfit / tot.revenue) * 100) : 0;

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-left border-collapse">
        <thead className="bg-surface-container-low border-b border-border">
          <tr>
            <Th>Zone</Th>
            <Th right>Orders</Th>
            <Th right>Returns</Th>
            <Th right>Return %</Th>
            <Th right>Revenue</Th>
            <Th right>Bank Recv.</Th>
            <Th right>Fees</Th>
            <Th right>COGS</Th>
            <Th right>Gross Profit</Th>
            <Th right>Margin %</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.map(r => {
            const margin = +r.revenue > 0 ? ((+r.grossProfit / +r.revenue) * 100) : 0;
            return (
              <tr key={r.shippingZone} className="hover:bg-surface-container-low transition-colors">
                <Td bold>{r.shippingZone}</Td>
                <Td right>{fmt(r.orders)}</Td>
                <Td right>{fmt(r.returns)}</Td>
                <Td right color={+r.returnRate > 20 ? 'text-rose-600' : 'text-secondary'}>{pct(r.returnRate)}</Td>
                <Td right>₹{fmt(r.revenue, 0)}</Td>
                <Td right>₹{fmt(r.bankReceived, 0)}</Td>
                <Td right color="text-amber-700">₹{fmt(r.fkTotalFees, 0)}</Td>
                <Td right color="text-orange-600">₹{fmt(r.cogs, 0)}</Td>
                <GpCell value={r.grossProfit} />
                <MarginCell value={margin} />
              </tr>
            );
          })}
        </tbody>
        <tfoot className="bg-surface-container-low font-bold border-t border-border">
          <tr>
            <Td>Total</Td>
            <Td right>{fmt(tot.orders)}</Td>
            <Td right>{fmt(tot.returns)}</Td>
            <Td right>{pct(tot.orders > 0 ? (tot.returns/tot.orders)*100 : 0)}</Td>
            <Td right>₹{fmt(tot.revenue, 0)}</Td>
            <Td right>₹{fmt(tot.bankReceived, 0)}</Td>
            <Td right color="text-amber-700">₹{fmt(tot.fkTotalFees, 0)}</Td>
            <Td right color="text-orange-600">₹{fmt(tot.cogs, 0)}</Td>
            <GpCell value={tot.grossProfit} />
            <MarginCell value={totMargin} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
