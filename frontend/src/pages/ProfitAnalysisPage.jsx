import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid, Cell, PieChart, Pie,
} from 'recharts';
import {
  fetchProfitAnalysis,
  fetchSkuMaster, fetchUnmappedSkus,
  uploadSkuMasterFile, addSkuMasterRow, updateSkuMasterRow,
  deleteSkuMasterRow, clearSkuMaster,
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
const WEIGHT_SLABS = [
  { value: 0.5,  label: '0 – 0.5 kg' },
  { value: 1,    label: '0.5 – 1 kg' },
  { value: 1.5,  label: '1 – 1.5 kg' },
  { value: 2,    label: '1.5 – 2 kg' },
  { value: 3,    label: '2 – 3 kg' },
  { value: 5,    label: '3 – 5 kg' },
  { value: 10,   label: '5 – 10 kg' },
];
function fmtWeightSlab(v) {
  if (v == null || v === '') return '—';
  const found = WEIGHT_SLABS.find(s => +s.value === +v);
  return found ? found.label : `${v} kg`;
}

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
    <div className={`rounded-2xl border px-5 py-4 shadow-sm ${colors[color]}`}>
      <div className="flex items-start justify-between mb-2">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-secondary">{label}</p>
        {icon && <span className="text-lg opacity-60">{icon}</span>}
      </div>
      <p className={`text-2xl font-bold leading-tight tabular-nums ${color !== 'slate' ? '' : 'text-ink'}`}>{animatedValue}</p>
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
    { label: '– FK Fees',      value: -s.fkTotalFees,       color: 'bg-amber-400',   pctOfRev: s.grossRevenue > 0 ? -((s.fkTotalFees/s.grossRevenue)*100) : 0 },
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
function Tab({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
        active ? 'bg-primary text-white shadow-sm' : 'text-secondary hover:text-ink hover:bg-surface-container'
      }`}
    >
      {label}
    </button>
  );
}

// ── Trend chart ─────────────────────────────────────────────────────────────────
function TrendChart({ data, groupBy }) {
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
        <Bar dataKey="fkTotalFees" name="FK Fees"      fill="#fbbf24" radius={[3,3,0,0]} maxBarSize={40} />
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
function Th({ children, right = false }) {
  return <th className={`px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-outline whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}>{children}</th>;
}
function Td({ children, right = false, bold = false, color = '' }) {
  return <td className={`px-3 py-2 text-xs whitespace-nowrap ${right ? 'text-right' : ''} ${bold ? 'font-semibold' : ''} ${color || 'text-ink'}`}>{children}</td>;
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

// ── Zone Table ──────────────────────────────────────────────────────────────
function ZoneTable({ data }) {
  if (!data?.length) return <div className="text-center text-outline py-12 text-sm">No data</div>;

  // Totals row
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
            <Th right>FK Fees</Th>
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
                <Td right bold color={margin >= 20 ? 'text-emerald-600' : margin >= 0 ? 'text-amber-600' : 'text-rose-600'}>
                  {margin.toFixed(1)}%
                </Td>
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
            <Td right color={totMargin >= 20 ? 'text-emerald-600' : totMargin >= 0 ? 'text-amber-600' : 'text-rose-600'}>
              {totMargin.toFixed(1)}%
            </Td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── Category table ───────────────────────────────────────────────────────────────
function CategoryTable({ data }) {
  if (!data?.length) return <div className="text-center text-outline py-12 text-sm">No data</div>;

  // Totals row
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
            <Th>Category</Th>
            <Th right>Orders</Th>
            <Th right>Returns</Th>
            <Th right>Return %</Th>
            <Th right>Revenue</Th>
            <Th right>Bank Recv.</Th>
            <Th right>FK Fees</Th>
            <Th right>COGS</Th>
            <Th right>Gross Profit</Th>
            <Th right>Margin %</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.map(r => {
            const margin = +r.revenue > 0 ? ((+r.grossProfit / +r.revenue) * 100) : 0;
            return (
              <tr key={r.category} className="hover:bg-surface-container-low transition-colors">
                <Td bold>{r.category}</Td>
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
            <MarginCell value={totMargin} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── SKU table ────────────────────────────────────────────────────────────────────
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
              <Th>Master SKU</Th>
              <Th>Category</Th>
              <Th right>Units</Th>
              <Th right>Revenue</Th>
              <Th right>Bank Recv.</Th>
              <Th right>FK Fees</Th>
              <Th right>COGS (total)</Th>
              <Th right>COGS/Unit</Th>
              <Th right>GP/Unit</Th>
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
                    <span title="No COGS data — upload SKU master to see accurate profit" className="ml-1 text-amber-500 cursor-help">⚠</span>
                  )}
                </Td>
                <Td><span className="font-mono text-[11px] text-primary">{r.masterSku === r.sku ? '—' : r.masterSku}</span></Td>
                <Td>{r.category}</Td>
                <Td right>{fmt(r.units)}</Td>
                <Td right>₹{fmt(r.revenue, 0)}</Td>
                <Td right>₹{fmt(r.bankReceived, 0)}</Td>
                <Td right color="text-amber-700">₹{fmt(r.fkTotalFees, 0)}</Td>
                <Td right color="text-orange-600">{r.hasCogs ? `₹${fmt(r.cogs, 0)}` : <span className="text-outline">—</span>}</Td>
                <Td right color="text-orange-600">{r.hasCogs ? `₹${fmt(r.cogsPerUnit, 0)}` : <span className="text-outline">—</span>}</Td>
                <GpCell value={r.hasCogs ? r.gpPerUnit : null} />
                <Td right color={+r.returnRate > 20 ? 'text-rose-600' : 'text-secondary'}>{pct(r.returnRate)}</Td>
                <GpCell value={r.grossProfit} />
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="text-center text-outline py-8 text-sm">No matching SKUs</div>}
      </div>
      <p className="text-[11px] text-outline">Showing top 30 SKUs by revenue. ⚠ = COGS not configured — profits shown are estimates.</p>
    </div>
  );
}

// ── Account table ────────────────────────────────────────────────────────────────
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

  // Mini bar chart for accounts
  const maxRev = Math.max(...data.map(r => +r.revenue));

  return (
    <div className="space-y-4">
      {/* Mini bar comparison */}
      <div className="bg-surface-container-low rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-secondary uppercase tracking-wider">Revenue by Account</p>
        {data.map(r => (
          <div key={r.sellerAccount} className="flex items-center gap-3">
            <div className="w-28 text-xs font-medium text-secondary truncate">{r.sellerAccount}</div>
            <div className="flex-1 bg-surface-container-high rounded-full h-3 overflow-hidden">
              <div
                className="h-full bg-primary rounded-full"
                style={{ width: `${maxRev > 0 ? (+r.revenue/maxRev)*100 : 0}%` }}
              />
            </div>
            <div className="w-24 text-xs font-semibold text-right text-ink">{fmtK(r.revenue)}</div>
          </div>
        ))}
      </div>

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
              <Th right>FK Fees</Th>
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
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────────
// ── SKU Master & COGS — config panel (admin/owner use) ────────────────────────
const MP_BADGE = {
  flipkart: 'bg-primary-container text-primary',
  amazon:   'bg-amber-100 text-amber-700',
  myntra:   'bg-pink-100 text-pink-700',
  meesho:   'bg-purple-100 text-purple-700',
  all:      'bg-surface-container text-secondary',
};
function mpCls(mp) { return MP_BADGE[(mp||'').toLowerCase()] || 'bg-surface-container text-secondary'; }

function SkuMasterSection() {
  const fileRef = useRef();
  const [skuData, setSkuData]   = useState(null);
  const [unmapped, setUnmapped] = useState(null);
  const [skuTab, setSkuTab]     = useState('master');
  const [loadingRows, setLoadingRows] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [uploadError, setUploadError]   = useState(null);
  const [page, setPage]   = useState(1);
  const [search, setSearch] = useState('');
  const [dragging, setDragging] = useState(false);
  const [adding, setAdding]     = useState(false);
  const [addForm, setAddForm]   = useState({ master_sku: '', marketplace: 'all', listing_sku: '', cogs: '', launch_date: '', product_name: '', weight_slab: '' });
  const [addErr, setAddErr]     = useState(null);
  const [editId, setEditId]     = useState(null);
  const [editForm, setEditForm] = useState({});
  const [configSku, setConfigSku]   = useState(null);
  const [configForm, setConfigForm] = useState({ master_sku: '', cogs: '', launch_date: '', product_name: '', weight_slab: '' });
  const [configErr, setConfigErr]   = useState(null);
  const [configBusy, setConfigBusy] = useState(false);

  const loadRows = useCallback(async () => {
    setLoadingRows(true);
    try { setSkuData(await fetchSkuMaster(undefined, search || undefined, page)); }
    catch { /* ignore */ }
    setLoadingRows(false);
  }, [search, page]);

  const loadUnmapped = useCallback(async () => {
    try { setUnmapped(await fetchUnmappedSkus()); }
    catch { /* ignore */ }
  }, []);

  useEffect(() => { loadRows(); loadUnmapped(); }, [loadRows, loadUnmapped]);

  const handleFile = async (f) => {
    if (!f) return;
    setUploading(true); setUploadError(null); setUploadResult(null);
    try {
      const fd = new FormData(); fd.append('file', f);
      const r = await uploadSkuMasterFile(fd);
      setUploadResult(r); loadRows(); loadUnmapped();
    } catch (e) { setUploadError(e?.response?.data?.error || e.message); }
    setUploading(false);
  };

  const handleAdd = async () => {
    if (!addForm.listing_sku.trim()) { setAddErr('Listing SKU required'); return; }
    setAddErr(null);
    try {
      // Preserve the raw values so the API can reject malformed COGS instead of
      // JavaScript quietly turning it into zero.
      await addSkuMasterRow(addForm);
      setAdding(false);
      setAddForm({ master_sku: '', marketplace: 'all', listing_sku: '', cogs: '', launch_date: '', product_name: '', weight_slab: '' });
      loadRows(); loadUnmapped();
    } catch (e) { setAddErr(e?.response?.data?.error || e.message); }
  };

  const handleEdit = async (id) => {
    try {
      await updateSkuMasterRow(id, editForm);
      setEditId(null); loadRows();
    } catch (e) { alert(e?.response?.data?.error || e.message); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Remove this SKU mapping?')) return;
    try { await deleteSkuMasterRow(id); loadRows(); loadUnmapped(); }
    catch (e) { alert(e?.response?.data?.error || e.message); }
  };

  const handleClear = async () => {
    if (!window.confirm('Delete ALL SKU master mappings? This removes COGS data for all SKUs.')) return;
    try { await clearSkuMaster('all'); loadRows(); loadUnmapped(); setUploadResult(null); }
    catch (e) { alert(e?.response?.data?.error || e.message); }
  };

  const handleConfigSave = async () => {
    if (!configSku) return;
    if (!configForm.cogs) { setConfigErr('COGS required'); return; }
    setConfigBusy(true); setConfigErr(null);
    try {
      await addSkuMasterRow({
        listing_sku: configSku.sku, master_sku: configForm.master_sku || configSku.sku,
        marketplace: configSku.marketplace || 'all', cogs: configForm.cogs,
        launch_date: configForm.launch_date || null, product_name: configForm.product_name || '',
        weight_slab: configForm.weight_slab,
      });
      setConfigSku(null); loadRows(); loadUnmapped();
    } catch (e) { setConfigErr(e?.response?.data?.error || e.message); }
    setConfigBusy(false);
  };

  const downloadTemplate = () => {
    const wb = XLSX.utils.book_new();
    // Weight Slab validation note in Col G header
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Master SKU','Marketplace','Listing SKU','COGS (₹)','Launch Date','Product Name','Weight Slab (kg)'],
      ['','','','','','','Valid values: 0-0.5 / 0.5-1 / 1-1.5 / 1.5-2 / 2-3 / 3-5 / 5-10'],
      ['EJ1201-16001','flipkart','EJ1201-16001_FK',250,'2024-01-15','Ethnic Jacket','0-0.5'],
      ['EJ1201-16001','myntra','EJ1201-16001_M',250,'2024-01-15','Ethnic Jacket','0-0.5'],
      ['KL5502-20045','flipkart','KL5502-20045_FK',180,'2024-03-01','Kurti Set','0.5-1'],
    ]), 'Full Format');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['(Col A — optional)','Listing SKU (Col B)','COGS ₹ (Col C)','Wt Slab (Col D): 0-0.5 / 0.5-1 / 1-1.5 / 1.5-2 / 2-3 / 3-5 / 5-10'],
      ['','EJ1201-16001_FK',250,'0-0.5'],
      ['','KL5502-20045_FK',180,'0.5-1'],
    ]), 'Simple Format (Col B+C+D)');
    XLSX.writeFile(wb, 'sku_master_template.xlsx');
  };

  const rows = skuData?.data || [];
  const total = skuData?.total || 0;
  const totalPages = Math.ceil(total / 100);
  const unmappedCount = unmapped?.total || 0;

  return (
    <div className="space-y-4">
      {/* Sub-header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Sub-tabs */}
          <div className="flex gap-1 p-1 bg-surface-container rounded-xl">
            <button onClick={() => setSkuTab('master')}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${skuTab === 'master' ? 'bg-surface text-ink shadow-sm' : 'text-secondary hover:text-ink'}`}>
              SKU Mappings
            </button>
            <button onClick={() => setSkuTab('unmapped')}
              className={`relative px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${skuTab === 'unmapped' ? 'bg-surface text-ink shadow-sm' : 'text-secondary hover:text-ink'}`}>
              New SKUs
              {unmappedCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 h-4 min-w-4 px-1 bg-amber-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                  {unmappedCount > 99 ? '99+' : unmappedCount}
                </span>
              )}
            </button>
          </div>
          {total > 0 && <span className="text-[11px] text-emerald-700 font-semibold bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full">{total.toLocaleString()} SKUs configured</span>}
          {unmappedCount > 0 && <span className="text-[11px] text-amber-700 font-semibold bg-amber-50 border border-amber-200 px-2.5 py-0.5 rounded-full animate-pulse">⚠ {unmappedCount} need COGS</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={downloadTemplate}
            className="flex items-center gap-1.5 text-xs text-secondary hover:text-ink border border-border rounded-lg px-3 py-1.5 bg-surface hover:border-border transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            Template
          </button>
          {total > 0 && (
            <button onClick={handleClear}
              className="text-xs text-rose-500 hover:text-rose-700 border border-rose-200 rounded-lg px-3 py-1.5 bg-surface hover:bg-rose-50 transition-colors">
              Clear All
            </button>
          )}
        </div>
      </div>

      {/* ── SKU MAPPINGS tab ── */}
      {skuTab === 'master' && (
        <div className="space-y-4">
          {/* Format guide */}
          <div className="grid md:grid-cols-2 gap-3">
            <div className="bg-primary-container border border-primary rounded-xl p-3.5">
              <p className="text-[10px] font-bold text-primary uppercase tracking-wider mb-2">Simple Format — Col B = Listing SKU, Col C = COGS, Col D = Wt (kg)</p>
              <table className="text-[11px] w-full font-mono">
                <thead><tr className="text-indigo-400"><td className="pr-3 pb-1">Col A</td><td className="pr-3 pb-1">Col B</td><td className="pr-3 pb-1">Col C</td><td className="pb-1">Col D</td></tr></thead>
                <tbody className="text-ink">
                  <tr><td className="pr-3 text-outline">—</td><td className="pr-3">EJ1201_FK</td><td className="text-emerald-700 font-bold pr-3">250</td><td className="text-primary">0.5</td></tr>
                  <tr><td className="pr-3 text-outline">—</td><td className="pr-3">KL5502_FK</td><td className="text-emerald-700 font-bold pr-3">180</td><td className="text-primary">1</td></tr>
                </tbody>
              </table>
              <p className="text-[10px] text-indigo-400 mt-1.5">Master SKU auto-set to Listing SKU · applies to all marketplaces</p>
            </div>
            <div className="bg-surface-container-low border border-border rounded-xl p-3.5">
              <p className="text-[10px] font-bold text-secondary uppercase tracking-wider mb-2">Full Format — all columns</p>
              <table className="text-[11px] w-full font-mono">
                <thead><tr className="text-outline"><td className="pr-3 pb-1">Master SKU</td><td className="pr-3 pb-1">MP</td><td className="pr-3 pb-1">Listing SKU</td><td className="pb-1">COGS</td></tr></thead>
                <tbody className="text-ink">
                  <tr><td className="pr-3">EJ1201</td><td className="pr-3">fk</td><td className="pr-3">EJ1201_FK</td><td className="text-emerald-700 font-bold">250</td></tr>
                  <tr><td className="pr-3">EJ1201</td><td className="pr-3">my</td><td className="pr-3">EJ1201_M</td><td className="text-emerald-700 font-bold">250</td></tr>
                </tbody>
              </table>
              <p className="text-[10px] text-outline mt-1.5">Also supports: Launch Date · Product Name · Weight Slab columns</p>
            </div>
          </div>

          {/* Upload zone */}
          <div
            className={`border-2 border-dashed rounded-xl flex flex-col items-center justify-center gap-2 py-6 cursor-pointer transition-colors ${
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
              <p className="text-sm font-semibold text-primary">Uploading…</p></>
            ) : (
              <><svg className="w-6 h-6 text-outline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" /></svg>
              <div className="text-center">
                <p className="text-sm text-secondary font-medium">Drop SKU Master file here, or click to browse</p>
                <p className="text-xs text-outline">.xlsx / .xls / .csv · Simple (Col B+C) and full formats both accepted</p>
              </div></>
            )}
          </div>

          {uploadResult && (
            <div className="flex items-center gap-4 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs">
              <span className="text-emerald-600 text-lg">✓</span>
              <span><strong className="text-emerald-700">{uploadResult.inserted}</strong> new</span>
              <span><strong className="text-primary">{uploadResult.updated}</strong> updated</span>
              {uploadResult.skipped > 0 && <span><strong className="text-amber-600">{uploadResult.skipped}</strong> skipped</span>}
              <span className="text-outline">of {uploadResult.total} rows</span>
            </div>
          )}
          {uploadError && <p className="text-xs text-rose-600 font-medium">✗ {uploadError}</p>}

          {/* Mappings table */}
          <div className="rounded-xl border border-border overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 bg-surface-container-low border-b border-border">
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-secondary">{total.toLocaleString()} mappings</span>
                <input type="text" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
                  placeholder="Search SKU…"
                  className="text-xs border border-border rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary w-44 bg-surface" />
              </div>
              <button onClick={() => { setAdding(true); setAddErr(null); }}
                className="flex items-center gap-1.5 text-xs font-semibold text-white bg-primary hover:bg-primary rounded-lg px-3 py-1.5 transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                Add SKU
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-surface-container-low border-b border-border text-secondary">
                    <th className="text-left px-4 py-2.5 font-semibold">Listing SKU</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Master SKU</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Marketplace</th>
                    <th className="text-left px-4 py-2.5 font-semibold">COGS (₹)</th>
                    <th className="text-left px-4 py-2.5 font-semibold whitespace-nowrap">Wt Slab (kg)</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Launch Date</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Product Name</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {adding && (
                    <tr className="bg-indigo-50/40">
                      <td className="px-3 py-2"><input autoFocus value={addForm.listing_sku} onChange={e => setAddForm(f => ({...f, listing_sku: e.target.value}))} placeholder="Listing SKU *" className="w-full text-xs border border-primary rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary font-mono" /></td>
                      <td className="px-3 py-2"><input value={addForm.master_sku} onChange={e => setAddForm(f => ({...f, master_sku: e.target.value}))} placeholder="= Listing if blank" className="w-full text-xs border border-border rounded-lg px-2 py-1 focus:outline-none font-mono" /></td>
                      <td className="px-3 py-2">
                        <select value={addForm.marketplace} onChange={e => setAddForm(f => ({...f, marketplace: e.target.value}))} className="text-xs border border-border rounded-lg px-2 py-1 bg-surface">
                          {['all','flipkart','amazon','myntra','meesho'].map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2"><input type="number" value={addForm.cogs} onChange={e => setAddForm(f => ({...f, cogs: e.target.value}))} placeholder="0" className="w-24 text-xs border border-border rounded-lg px-2 py-1 text-right" /></td>
                      <td className="px-3 py-2">
                        <select value={addForm.weight_slab} onChange={e => setAddForm(f => ({...f, weight_slab: e.target.value}))} className="text-xs border border-border rounded-lg px-2 py-1 bg-surface w-20">
                          <option value="">—</option>
                          {WEIGHT_SLABS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2"><input type="date" value={addForm.launch_date} onChange={e => setAddForm(f => ({...f, launch_date: e.target.value}))} className="text-xs border border-border rounded-lg px-2 py-1" /></td>
                      <td className="px-3 py-2"><input value={addForm.product_name} onChange={e => setAddForm(f => ({...f, product_name: e.target.value}))} placeholder="Product name" className="w-full text-xs border border-border rounded-lg px-2 py-1" /></td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1.5">
                          <button onClick={handleAdd} className="text-[10px] font-bold text-white bg-primary hover:bg-primary px-2.5 py-1 rounded-lg">Save</button>
                          <button onClick={() => setAdding(false)} className="text-[10px] text-outline px-2.5 py-1 rounded-lg border border-border">Cancel</button>
                        </div>
                        {addErr && <p className="text-[10px] text-rose-600 mt-0.5">{addErr}</p>}
                      </td>
                    </tr>
                  )}
                  {loadingRows ? (
                    <tr><td colSpan={8} className="px-4 py-8 text-center text-outline">Loading…</td></tr>
                  ) : rows.length === 0 ? (
                    <tr><td colSpan={8} className="px-4 py-10 text-center text-outline">
                      {search ? `No results for "${search}"` : 'No SKUs mapped yet — upload a file or click Add SKU'}
                    </td></tr>
                  ) : rows.map(r => (
                    editId === r.id ? (
                      <tr key={r.id} className="bg-indigo-50/40">
                        <td className="px-3 py-2 font-mono text-[11px] text-primary">{r.listing_sku}</td>
                        <td className="px-3 py-2"><input value={editForm.master_sku ?? ''} onChange={e => setEditForm(f => ({...f, master_sku: e.target.value}))} className="w-full text-xs border border-primary rounded-lg px-2 py-1 font-mono" /></td>
                        <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold capitalize ${mpCls(r.marketplace)}`}>{r.marketplace}</span></td>
                        <td className="px-3 py-2"><input type="number" value={editForm.cogs ?? ''} onChange={e => setEditForm(f => ({...f, cogs: e.target.value}))} className="w-24 text-xs border border-primary rounded-lg px-2 py-1 text-right" /></td>
                        <td className="px-3 py-2">
                          <select value={editForm.weight_slab ?? ''} onChange={e => setEditForm(f => ({...f, weight_slab: e.target.value}))} className="text-xs border border-border rounded-lg px-2 py-1 bg-surface w-20">
                            <option value="">—</option>
                            {WEIGHT_SLABS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2"><input type="date" value={editForm.launch_date ?? ''} onChange={e => setEditForm(f => ({...f, launch_date: e.target.value}))} className="text-xs border border-border rounded-lg px-2 py-1" /></td>
                        <td className="px-3 py-2"><input value={editForm.product_name ?? ''} onChange={e => setEditForm(f => ({...f, product_name: e.target.value}))} className="w-full text-xs border border-border rounded-lg px-2 py-1" /></td>
                        <td className="px-3 py-2">
                          <div className="flex gap-1.5">
                            <button onClick={() => handleEdit(r.id)} className="text-[10px] font-bold text-white bg-primary hover:bg-primary px-2.5 py-1 rounded-lg">Save</button>
                            <button onClick={() => setEditId(null)} className="text-[10px] text-outline px-2.5 py-1 rounded-lg border border-border">Cancel</button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr key={r.id} className="hover:bg-surface-container-low/60 transition-colors group">
                        <td className="px-4 py-2.5 font-mono text-[11px] text-ink font-semibold">{r.listing_sku}</td>
                        <td className="px-4 py-2.5 font-mono text-[11px] text-primary">{r.master_sku}</td>
                        <td className="px-4 py-2.5"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold capitalize ${mpCls(r.marketplace)}`}>{r.marketplace}</span></td>
                        <td className="px-4 py-2.5 font-bold text-emerald-700">₹{(+r.cogs).toLocaleString('en-IN')}</td>
                        <td className="px-4 py-2.5 text-secondary font-mono text-[11px]">{fmtWeightSlab(r.weight_slab)}</td>
                        <td className="px-4 py-2.5 text-outline">{r.launch_date ? new Date(r.launch_date).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : '—'}</td>
                        <td className="px-4 py-2.5 text-secondary max-w-[140px] truncate">{r.product_name || '—'}</td>
                        <td className="px-4 py-2.5 text-right opacity-0 group-hover:opacity-100 transition-opacity">
                          <div className="flex items-center gap-1.5 justify-end">
                            <button onClick={() => { setEditId(r.id); setEditForm({ master_sku: r.master_sku, cogs: r.cogs, weight_slab: r.weight_slab != null ? r.weight_slab : '', launch_date: r.launch_date ? r.launch_date.slice(0,10) : '', product_name: r.product_name || '' }); }}
                              className="text-outline hover:text-primary p-0.5 transition-colors">
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.536-6.536a2 2 0 012.828 2.828L11.828 15.828a2 2 0 01-1.414.586H9v-2.414a2 2 0 01.586-1.414z" /></svg>
                            </button>
                            <button onClick={() => handleDelete(r.id)} className="text-outline hover:text-rose-500 p-0.5 transition-colors">
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
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
        </div>
      )}

      {/* ── NEW SKUs tab ── */}
      {skuTab === 'unmapped' && (
        <div className="space-y-3">
          {unmappedCount === 0 ? (
            <div className="py-14 text-center">
              <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-3 text-2xl">✓</div>
              <p className="text-sm font-semibold text-emerald-700">All order SKUs have COGS configured!</p>
              <p className="text-xs text-outline mt-1">Every SKU in your orders is mapped in the master.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl">
                <span className="text-amber-500 text-xl shrink-0">⚠</span>
                <div>
                  <p className="text-xs font-bold text-amber-800">{unmappedCount} SKUs found in orders without COGS</p>
                  <p className="text-[11px] text-amber-600 mt-0.5">Click any row to configure COGS — profit analysis will be incomplete until done.</p>
                </div>
              </div>

              {configSku && (
                <div className="rounded-xl border-2 border-primary bg-indigo-50/40 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-bold text-primary">Configure: <span className="font-mono">{configSku.sku}</span></p>
                      <p className="text-xs text-primary mt-0.5">{configSku.marketplace} · {configSku.category} · {configSku.order_count} orders</p>
                    </div>
                    <button onClick={() => setConfigSku(null)} className="text-outline hover:text-secondary">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    <div>
                      <label className="text-[10px] font-semibold text-secondary uppercase tracking-wider mb-1 block">Master SKU</label>
                      <input value={configForm.master_sku} onChange={e => setConfigForm(f => ({...f, master_sku: e.target.value}))}
                        placeholder={`= ${configSku.sku}`}
                        className="w-full text-xs border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary font-mono bg-surface" />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold text-secondary uppercase tracking-wider mb-1 block">COGS (₹) *</label>
                      <input type="number" value={configForm.cogs} onChange={e => setConfigForm(f => ({...f, cogs: e.target.value}))}
                        placeholder="Cost price" className="w-full text-xs border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary bg-surface" />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold text-secondary uppercase tracking-wider mb-1 block">Weight Slab</label>
                      <select value={configForm.weight_slab} onChange={e => setConfigForm(f => ({...f, weight_slab: e.target.value}))}
                        className="w-full text-xs border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary bg-surface">
                        <option value="">— select —</option>
                        {WEIGHT_SLABS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold text-secondary uppercase tracking-wider mb-1 block">SKU Launch Date</label>
                      <input type="date" value={configForm.launch_date} onChange={e => setConfigForm(f => ({...f, launch_date: e.target.value}))}
                        className="w-full text-xs border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary bg-surface" />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold text-secondary uppercase tracking-wider mb-1 block">Product Name</label>
                      <input value={configForm.product_name} onChange={e => setConfigForm(f => ({...f, product_name: e.target.value}))}
                        placeholder="Display name" className="w-full text-xs border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary bg-surface" />
                    </div>
                  </div>
                  {configErr && <p className="text-xs text-rose-600">✗ {configErr}</p>}
                  <div className="flex gap-2">
                    <button onClick={handleConfigSave} disabled={configBusy}
                      className="text-xs font-bold text-white bg-primary hover:bg-primary disabled:opacity-60 px-4 py-2 rounded-lg">
                      {configBusy ? 'Saving…' : 'Save to Master'}
                    </button>
                    <button onClick={() => setConfigSku(null)} className="text-xs text-secondary px-4 py-2 rounded-lg border border-border hover:bg-surface-container-low">Cancel</button>
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-amber-50 border-b border-amber-100 text-secondary">
                      <th className="text-left px-4 py-2.5 font-semibold">SKU</th>
                      <th className="text-left px-4 py-2.5 font-semibold">Marketplace</th>
                      <th className="text-left px-4 py-2.5 font-semibold">Category</th>
                      <th className="text-right px-4 py-2.5 font-semibold">Orders</th>
                      <th className="text-right px-4 py-2.5 font-semibold">Revenue</th>
                      <th className="text-left px-4 py-2.5 font-semibold">First Seen</th>
                      <th className="text-left px-4 py-2.5 font-semibold">Last Seen</th>
                      <th className="px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {(unmapped?.unmapped || []).map((r, i) => (
                      <tr key={i}
                        className={`cursor-pointer transition-colors ${configSku?.sku === r.sku && configSku?.marketplace === r.marketplace ? 'bg-primary-container ring-1 ring-inset ring-primary' : 'hover:bg-amber-50/40'}`}
                        onClick={() => { setConfigSku(r); setConfigForm({ master_sku: '', cogs: '', launch_date: '', product_name: '', weight_slab: '' }); setConfigErr(null); }}
                      >
                        <td className="px-4 py-3 font-mono font-semibold text-ink max-w-[160px] truncate">{r.sku}</td>
                        <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold capitalize ${mpCls(r.marketplace)}`}>{r.marketplace}</span></td>
                        <td className="px-4 py-3 text-secondary">{r.category || '—'}</td>
                        <td className="px-4 py-3 text-right font-bold text-ink">{(+r.order_count).toLocaleString()}</td>
                        <td className="px-4 py-3 text-right text-emerald-700 font-medium">{fmtK(r.total_revenue)}</td>
                        <td className="px-4 py-3 text-outline">{r.first_order_date?.slice(0,10) || '—'}</td>
                        <td className="px-4 py-3 text-outline">{r.last_order_date?.slice(0,10) || '—'}</td>
                        <td className="px-4 py-3 text-primary text-[10px] font-semibold whitespace-nowrap">Configure →</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function ProfitAnalysisPage() {
  const { filters, refreshKey } = useFilters();
  const [tab,           setTab]           = useState('overview');
  const [sellerAccount, setSellerAccount] = useState('all');
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

  // Build account selector options from byAccount data
  const accounts = data?.byAccount?.map(r => r.sellerAccount) || [];
  const showAccountFilter = accounts.length > 1;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink">SKU Profitability</h1>
          <p className="text-sm text-secondary mt-0.5">Revenue − fees − returns − COGS = Gross profit by SKU / category</p>
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

      {/* COGS warning */}
      {data && !loading && !hasCogs && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-3 flex items-center gap-3">
          <span className="text-amber-500 text-lg">⚠️</span>
          <div>
            <p className="text-sm font-semibold text-amber-800">COGS not configured</p>
            <p className="text-xs text-amber-600">Gross profit shown excludes cost of goods. <button onClick={() => setTab('cogsconfig')} className="underline font-semibold hover:text-amber-800">Configure COGS</button> in the COGS Config tab to see accurate margins.</p>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between gap-3 bg-rose-50 border border-rose-200 rounded-2xl px-5 py-3 text-rose-700 text-sm">
          <span>{data ? `Showing the last verified profitability report. ${error}` : error}</span>
          <button onClick={refetch} className="shrink-0 rounded-lg border border-rose-200 bg-surface px-3 py-1.5 text-xs font-bold text-rose-700">Retry</button>
        </div>
      )}

      {loading && data && <div className="rounded-xl border border-border bg-surface-container-low px-4 py-2 text-center text-xs font-semibold text-secondary">Refreshing profitability report…</div>}

      {/* KPI Cards */}
      {loading && !data ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array(6).fill(0).map((_, i) => (
            <div key={i} className="rounded-2xl border border-border px-5 py-4 animate-pulse bg-surface-container h-24" />
          ))}
        </div>
      ) : s && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <KpiCard label="Gross Revenue"   value={fmtK(s.grossRevenue)}  sub={`${fmt(s.totalOrders)} orders`}                         color="indigo"  icon="📦" />
          <KpiCard label="Bank Received"   value={fmtK(s.bankReceived)}  sub={`After refunds: −${fmtK(s.totalRefunds)}`}               color="slate"   icon="🏦" />
          <KpiCard label="FK Total Fees"   value={fmtK(s.fkTotalFees)}   sub={s.grossRevenue > 0 ? `${((s.fkTotalFees/s.grossRevenue)*100).toFixed(1)}% of revenue` : ''}  color="amber"   icon="💸" />
          <KpiCard label="Total COGS"      value={hasCogs ? fmtK(s.totalCogs) : '—'} sub={hasCogs ? (s.grossRevenue > 0 ? `${((s.totalCogs/s.grossRevenue)*100).toFixed(1)}% of revenue` : '') : 'Upload SKU master'} color={hasCogs ? "slate" : "amber"} icon="🏭" />
          <KpiCard label="Gross Profit"    value={fmtK(s.grossProfit)}   sub={`After all deductions`}                                   color={s.grossProfit >= 0 ? 'emerald' : 'rose'} icon="💰" trend={s.profitMarginPct} />
          <KpiCard label="Returns"         value={fmt(s.returnCount)}    sub={`${pct(s.returnRate)} return rate`}                       color={s.returnRate > 20 ? 'rose' : 'slate'} icon="↩️" />
        </div>
      )}

      {/* Tabs */}
      <div className="bg-surface rounded-2xl border border-border shadow-sm">
        <div className="flex items-center gap-1 px-4 pt-4 pb-0 border-b border-border">
          {[
            { key: 'overview',   label: 'Overview' },
            { key: 'category',   label: 'By Category' },
            { key: 'sku',        label: 'Top SKUs' },
            { key: 'account',    label: 'By Account' },
            { key: 'zone',       label: 'By Zone' },
            { key: 'cogsconfig', label: '🔒 COGS Config' },
          ].map(t => (
            <Tab key={t.key} label={t.label} active={tab === t.key} onClick={() => setTab(t.key)} />
          ))}
        </div>

        <div className="p-6">
          {loading && !data ? (
            <div className="flex items-center justify-center py-16">
              <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* ── Overview ── */}
              {tab === 'overview' && (
                <div className="space-y-8">
                  {/* Trend chart */}
                  <div>
                    <p className="text-sm font-semibold text-ink mb-4">Trend — Revenue / FK Fees / COGS / Gross Profit</p>
                    <TrendChart data={data?.trend} groupBy={filters.groupBy} />
                  </div>

                  {/* Profit waterfall + fee pie side by side */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <div>
                      <p className="text-sm font-semibold text-ink mb-4">Profit Waterfall</p>
                      <ProfitFlow s={s} />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-ink mb-4">FK Fee Breakdown</p>
                      <FeePie fees={s?.fees} total={s?.fkTotalFees} />
                    </div>
                  </div>

                  {/* Fee chips */}
                  <div>
                    <p className="text-xs font-semibold text-outline uppercase tracking-wider mb-2">FK Fee Details</p>
                    <FeeRow fees={s?.fees} />
                  </div>
                </div>
              )}

              {/* ── By Category ── */}
              {tab === 'category' && (
                <div className="space-y-4">
                  <p className="text-sm font-semibold text-ink">Category-wise Profit Breakdown</p>
                  <CategoryTable data={data?.byCategory} />
                </div>
              )}

              {/* ── Top SKUs ── */}
              {tab === 'sku' && (
                <div className="space-y-4">
                  <p className="text-sm font-semibold text-ink">Top 30 SKUs by Revenue</p>
                  <SkuTable data={data?.bySkuTop} />
                </div>
              )}

              {/* ── By Account ── */}
              {tab === 'account' && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-ink">Account / Brand Comparison</p>
                    <span className="text-[11px] bg-surface-container text-secondary rounded px-2 py-0.5">always shows all accounts regardless of filter above</span>
                  </div>
                  <AccountTable data={data?.byAccount} />
                </div>
              )}

              {/* ── By Zone ── */}
              {tab === 'zone' && (
                <div className="space-y-4">
                  <p className="text-sm font-semibold text-ink">Zone-wise Profit Breakdown</p>
                  <ZoneTable data={data?.byZone} />
                </div>
              )}


              {/* ── COGS Config ── */}
              {tab === 'cogsconfig' && <SkuMasterSection />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
