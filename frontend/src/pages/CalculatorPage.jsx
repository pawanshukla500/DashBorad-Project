import { useState, useEffect, useCallback } from 'react';
import { calculateRateCardFees, compareMarketplaceFees, fetchRateCardCategories, refreshRateCard } from '../api/client';
import { currencyFull, pct } from '../utils/format';

const ZONES       = ['local', 'zonal', 'national'];
const FULFILMENTS = ['NON_FBF', 'FBF'];
const PAYMENTS    = ['prepaid', 'postpaid'];

const FEE_COLORS = {
  commission:    { bg: 'bg-rose-100',   text: 'text-rose-700',   bar: '#f43f5e' },
  fixedFee:      { bg: 'bg-amber-100',  text: 'text-amber-700',  bar: '#f59e0b' },
  collectionFee: { bg: 'bg-orange-100', text: 'text-orange-700', bar: '#f97316' },
  gstOnFees:     { bg: 'bg-violet-100', text: 'text-violet-700', bar: '#8b5cf6' },
  reverseShipping:{ bg: 'bg-pink-100',  text: 'text-pink-700',   bar: '#ec4899' },
  tcs:           { bg: 'bg-surface-container',  text: 'text-secondary',  bar: '#94a3b8' },
  netToSeller:   { bg: 'bg-emerald-100',text: 'text-emerald-700',bar: '#10b981' },
};

const FEE_LABELS = {
  commission: 'Commission', fixedFee: 'Fixed Fee', collectionFee: 'Collection Fee',
  gstOnFees: 'GST on Fees (18%)', reverseShipping: 'Reverse Shipping', tcs: 'TCS (1%)',
  netToSeller: 'Net to You',
};

export default function CalculatorPage() {
  const [categories, setCategories]   = useState([]);
  const [mode, setMode]               = useState('single'); // single | compare
  const [loading, setLoading]         = useState(false);
  const [result, setResult]           = useState(null);
  const [compareResult, setCompareResult] = useState(null);
  const [refreshing, setRefreshing]   = useState(false);
  const [form, setForm] = useState({
    category:      '',
    price:         '',
    fulfilmentType:'NON_FBF',
    zone:          'national',
    paymentType:   'prepaid',
    weight:        '0.5',
    isReturn:      false,
    orderDate:     new Date().toISOString().slice(0, 10),
  });

  useEffect(() => {
    fetchRateCardCategories()
      .then(d => {
        setCategories(d.categories || []);
        if (!form.category && d.categories?.length) {
          setForm(f => ({ ...f, category: d.categories[0] }));
        }
      })
      .catch(() => {});
  }, []);

  const calculate = useCallback(async () => {
    if (!form.category || !form.price) return;
    setLoading(true);
    try {
      if (mode === 'compare') {
        const r = await compareMarketplaceFees(form);
        setCompareResult(r);
      } else {
        const r = await calculateRateCardFees(form);
        setResult(r);
      }
    } catch { }
    setLoading(false);
  }, [form, mode]);

  useEffect(() => {
    const t = setTimeout(calculate, 300);
    return () => clearTimeout(t);
  }, [calculate]);

  function set(k, v) { setForm(f => ({ ...f, [k]: v })); }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refreshRateCard();
      const d = await fetchRateCardCategories();
      setCategories(d?.categories || []);
    } catch (err) {
      console.error('[CalculatorPage] Refresh rate card failed:', err);
    }
    setRefreshing(false);
  }

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-ink">Fee Calculator</h1>
          <p className="text-sm text-outline mt-0.5">
            Real-time fee calculation from Flipkart Rate Card
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleRefresh} disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border border-border text-secondary hover:bg-surface-container-low disabled:opacity-50 transition-colors">
            <svg className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh Rate Card
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-5">
        {/* â”€â”€ Inputs â”€â”€ */}
        <div className="xl:col-span-2 bg-surface rounded-xl border border-border p-5 space-y-4">
          <h2 className="text-sm font-bold text-ink uppercase tracking-wide">Order Parameters</h2>

          {/* Category */}
          <Field label="Category">
            <select value={form.category} onChange={e => set('category', e.target.value)}
              className="w-full text-sm border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary bg-surface">
              {categories.length === 0 && <option value="">Loadingâ€¦</option>}
              {categories.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
            </select>
          </Field>

          {/* Price */}
          <Field label="Sale Price (â‚¹)">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-outline text-sm font-medium">â‚¹</span>
              <input
                type="number" min="0" step="1" value={form.price}
                onChange={e => set('price', e.target.value)}
                placeholder="Enter sale price"
                className="w-full pl-7 pr-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          </Field>

          {/* Fulfilment */}
          <Field label="Fulfilment Type">
            <div className="flex gap-2">
              {FULFILMENTS.map(f => (
                <button key={f} onClick={() => set('fulfilmentType', f)}
                  className={`flex-1 py-2 text-xs font-semibold rounded-lg border transition-all ${
                    form.fulfilmentType === f
                      ? 'bg-primary text-white border-primary'
                      : 'border-border text-secondary hover:bg-surface-container-low'
                  }`}>
                  {f === 'FBF' ? 'FBF (Flipkart)' : 'Non-FBF (Self)'}
                </button>
              ))}
            </div>
          </Field>

          {/* Payment Type */}
          <Field label="Payment Type">
            <div className="flex gap-2">
              {PAYMENTS.map(pt => (
                <button key={pt} onClick={() => set('paymentType', pt)}
                  className={`flex-1 py-2 text-xs font-semibold rounded-lg border capitalize transition-all ${
                    form.paymentType === pt
                      ? 'bg-primary text-white border-primary'
                      : 'border-border text-secondary hover:bg-surface-container-low'
                  }`}>
                  {pt}
                </button>
              ))}
            </div>
          </Field>

          {/* Zone */}
          <Field label="Delivery Zone">
            <div className="flex gap-2">
              {ZONES.map(z => (
                <button key={z} onClick={() => set('zone', z)}
                  className={`flex-1 py-2 text-xs font-semibold rounded-lg border capitalize transition-all ${
                    form.zone === z
                      ? 'bg-primary text-white border-primary'
                      : 'border-border text-secondary hover:bg-surface-container-low'
                  }`}>
                  {z}
                </button>
              ))}
            </div>
          </Field>

          {/* Return toggle + Weight */}
          <Field label="Is Return Order?">
            <div className="flex items-center gap-3">
              <button onClick={() => set('isReturn', !form.isReturn)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${form.isReturn ? 'bg-primary' : 'bg-surface-container-high'}`}>
                <span className={`inline-block h-4 w-4 transform rounded-full bg-surface shadow transition-transform ${form.isReturn ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
              {form.isReturn && (
                <div className="flex-1 flex items-center gap-2">
                  <span className="text-xs text-secondary">Weight (kg)</span>
                  <input type="number" min="0" step="0.5" value={form.weight}
                    onChange={e => set('weight', e.target.value)}
                    className="w-20 px-2 py-1.5 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary" />
                </div>
              )}
            </div>
          </Field>

          {/* Date */}
          <Field label="Order Date">
            <input type="date" value={form.orderDate} onChange={e => set('orderDate', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary" />
          </Field>
        </div>

        {/* â”€â”€ Results â”€â”€ */}
        <div className="xl:col-span-3">
          {mode === 'single' ? (
            <FeeResult result={result} loading={loading} price={parseFloat(form.price) || 0} />
          ) : (
            <CompareResult result={compareResult} loading={loading} price={parseFloat(form.price) || 0} category={form.category} />
          )}
        </div>
      </div>
    </div>
  );
}

// â”€â”€â”€ Single Result â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function FeeResult({ result, loading, price }) {
  if (!price) return (
    <div className="bg-surface rounded-xl border border-border p-10 text-center h-full flex items-center justify-center">
      <div>
        <div className="text-4xl mb-3">ðŸ§®</div>
        <p className="text-secondary font-medium">Enter a sale price to calculate fees</p>
        <p className="text-outline text-sm mt-1">Select category and fill in parameters on the left</p>
      </div>
    </div>
  );

  if (loading && !result) return (
    <div className="bg-surface rounded-xl border border-border p-8 flex items-center justify-center h-full">
      <div className="flex items-center gap-3 text-primary">
        <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
        </svg>
        <span className="text-sm font-medium">Calculatingâ€¦</span>
      </div>
    </div>
  );

  if (!result) return null;

  const fees = [
    { key: 'commission',     label: FEE_LABELS.commission,     value: result.commission,    extra: result.commissionRate ? `${(result.commissionRate*100).toFixed(1)}% of price` : null, meta: result.commissionMeta },
    { key: 'fixedFee',       label: FEE_LABELS.fixedFee,       value: result.fixedFee,      extra: 'flat per item', meta: result.fixedFeeMeta },
    { key: 'collectionFee',  label: FEE_LABELS.collectionFee,  value: result.collectionFee, extra: result.collectionFeeRate ? `${(result.collectionFeeRate*100).toFixed(2)}% of price` : null, meta: result.collectionFeeMeta },
    { key: 'gstOnFees',      label: FEE_LABELS.gstOnFees,      value: result.gstOnFees,     extra: '18% on commission', meta: null },
    ...(result.reverseShipping ? [{ key: 'reverseShipping', label: FEE_LABELS.reverseShipping, value: result.reverseShipping, extra: null, meta: null }] : []),
  ].filter(f => f.value !== null && f.value !== undefined);

  const totalFees = result.totalFees || 0;
  const net       = result.netToSeller || 0;

  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      {/* Header bar */}
      <div className="bg-gradient-to-r from-indigo-600 to-indigo-500 px-6 py-5 text-white">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-indigo-200 text-xs font-semibold uppercase tracking-wide">Sale Price</p>
            <p className="text-3xl font-bold mt-0.5">{currencyFull(price)}</p>
          </div>
          <div className="text-right">
            <p className="text-indigo-200 text-xs font-semibold uppercase tracking-wide">Net to You</p>
            <p className="text-3xl font-bold mt-0.5">{currencyFull(net)}</p>
            <p className="text-indigo-200 text-sm">{result.marginPct?.toFixed(1)}% margin</p>
          </div>
        </div>
        {/* Visual bar */}
        <div className="mt-4 h-3 bg-primary/40 rounded-full overflow-hidden flex">
          {fees.map(f => (
            <div key={f.key} className="h-full transition-all duration-300"
              style={{ width: `${price > 0 ? (Math.abs(f.value) / price * 100) : 0}%`, backgroundColor: FEE_COLORS[f.key]?.bar }} />
          ))}
          <div className="h-full flex-1 bg-emerald-400/80 rounded-r-full" />
        </div>
      </div>

      {/* Fee breakdown */}
      <div className="p-5 space-y-3">
        <h3 className="text-xs font-bold text-secondary uppercase tracking-wide">Fee Breakdown</h3>
        {fees.map(f => (
          <FeeRow key={f.key} label={f.label} value={f.value} price={price} colorKey={f.key} extra={f.extra} meta={f.meta} />
        ))}

        {/* Divider */}
        <div className="border-t border-border pt-3 mt-1">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-rose-700">Total Flipkart Fees</span>
            <div className="text-right">
              <span className="text-lg font-bold text-rose-700">{currencyFull(totalFees)}</span>
              <span className="text-xs text-rose-500 ml-2">{price > 0 ? pct(totalFees / price * 100) : 'â€”'}</span>
            </div>
          </div>
        </div>

        {/* Net */}
        <div className="bg-emerald-50 rounded-xl p-4 flex items-center justify-between border border-emerald-100">
          <div>
            <p className="text-xs font-semibold text-emerald-600 uppercase tracking-wide">Net to You</p>
            <p className="text-xs text-emerald-500 mt-0.5">Sale Price âˆ’ Total Fees</p>
          </div>
          <div className="text-right">
            <p className="text-financial-lg font-semibold text-emerald-700">{currencyFull(net)}</p>
            <p className="text-xs text-emerald-500">{result.marginPct?.toFixed(1)}% margin</p>
          </div>
        </div>

        {/* TCS note */}
        {result.tcs > 0 && (
          <p className="text-[11px] text-outline bg-surface-container-low rounded-lg px-3 py-2">
            <span className="font-semibold">TCS â‚¹{result.tcs.toFixed(2)}</span> (1% e-commerce tax) â€” deducted from bank settlement but refunded when filing GST returns.
          </p>
        )}

        {result.commission === null && (
          <p className="text-[11px] text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
            Commission rate not found in rate card for this category/price/date combination.
          </p>
        )}
      </div>
    </div>
  );
}

// â”€â”€â”€ Compare Result â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function CompareResult({ result, loading, price, category }) {
  if (!price) return (
    <div className="bg-surface rounded-xl border border-border p-10 text-center h-full flex items-center justify-center">
      <div>
        <div className="text-4xl mb-3">âš–ï¸</div>
        <p className="text-secondary font-medium">Enter a sale price to compare</p>
      </div>
    </div>
  );

  if (loading && !result) return (
    <div className="bg-surface rounded-xl border border-border p-8 flex items-center justify-center">
      <svg className="w-5 h-5 animate-spin text-primary" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
      </svg>
    </div>
  );
  if (!result) return null;

  const { flipkart: fk, shopsy: sh } = result;
  const rows = [
    { label: 'Commission',     fk: fk?.commission,     sh: sh?.commission,     extra: fk?.commissionRate ? `${(fk.commissionRate*100).toFixed(1)}%` : null, shExtra: sh?.commissionRate ? `${(sh.commissionRate*100).toFixed(1)}%` : null },
    { label: 'Fixed Fee',      fk: fk?.fixedFee,       sh: sh?.fixedFee },
    { label: 'Collection Fee', fk: fk?.collectionFee,  sh: sh?.collectionFee },
    { label: 'GST on Fees',    fk: fk?.gstOnFees,      sh: sh?.gstOnFees },
    { label: 'Total Fees',     fk: fk?.totalFees,      sh: sh?.totalFees,      bold: true },
    { label: 'Net to You',     fk: fk?.netToSeller,    sh: sh?.netToSeller,    bold: true, highlight: true },
    { label: 'Margin %',       fk: fk?.marginPct,      sh: sh?.marginPct,      isMarg: true },
  ];

  const saving = sh && fk ? (sh.netToSeller || 0) - (fk?.netToSeller || 0) : 0;

  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      <div className="grid grid-cols-3 bg-surface-container-low border-b border-border">
        <div className="px-5 py-4 text-xs font-semibold text-secondary uppercase tracking-wide">Fee Type</div>
        <div className="px-5 py-4 text-center">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-primary-container text-primary rounded-full text-xs font-bold">
            <span className="w-2 h-2 rounded-full bg-primary inline-block" /> Flipkart
          </span>
        </div>
        <div className="px-5 py-4 text-center">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-orange-100 text-orange-700 rounded-full text-xs font-bold">
            <span className="w-2 h-2 rounded-full bg-orange-500 inline-block" /> Shopsy
          </span>
        </div>
      </div>
      <div className="divide-y divide-slate-50">
        {rows.map((row, i) => (
          <div key={i} className={`grid grid-cols-3 ${row.highlight ? 'bg-emerald-50' : ''}`}>
            <div className={`px-5 py-3 text-sm ${row.bold ? 'font-bold text-ink' : 'text-secondary'}`}>{row.label}</div>
            <CmpCell value={row.fk} bold={row.bold} isMarg={row.isMarg} extra={row.extra} color="indigo" price={price} />
            <CmpCell value={row.sh} bold={row.bold} isMarg={row.isMarg} extra={row.shExtra} color="orange" price={price} />
          </div>
        ))}
      </div>
      {saving !== 0 && (
        <div className={`px-5 py-4 text-center text-sm font-semibold ${saving > 0 ? 'bg-orange-50 text-orange-700' : 'bg-primary-container text-primary'}`}>
          {saving > 0
            ? `Shopsy earns you â‚¹${Math.abs(saving).toFixed(2)} more per order`
            : `Flipkart earns you â‚¹${Math.abs(saving).toFixed(2)} more per order`}
        </div>
      )}
    </div>
  );
}

function CmpCell({ value, bold, isMarg, extra, color, price }) {
  if (value === null || value === undefined) return <div className="px-5 py-3 text-center text-outline text-sm">N/A</div>;
  const isNeg = !isMarg && value < 0;
  const pctVal = !isMarg && price > 0 ? `${(Math.abs(value) / price * 100).toFixed(1)}%` : null;
  return (
    <div className="px-5 py-3 text-center">
      <span className={`text-sm ${bold ? 'font-bold' : 'font-medium'} ${
        isMarg ? (value >= 20 ? 'text-emerald-600' : value >= 0 ? 'text-amber-600' : 'text-rose-600') :
        isNeg ? 'text-rose-600' : `text-${color}-700`
      }`}>
        {isMarg ? `${value.toFixed(1)}%` : currencyFull(value)}
      </span>
      {pctVal && !bold && <div className="text-[10px] text-outline mt-0.5">{pctVal}</div>}
      {extra && <div className="text-[10px] text-outline mt-0.5">{extra}</div>}
    </div>
  );
}

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function fmtRateDate(v) {
  if (!v && v !== 0) return null;
  const d = typeof v === 'number'
    ? new Date(Math.round((v - 25569) * 86400000))
    : new Date(v);
  if (isNaN(d)) return null;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function rateDateRange(meta) {
  if (!meta) return null;
  const from = fmtRateDate(meta.startDate);
  const to   = meta.endDate ? fmtRateDate(meta.endDate) : 'Current';
  if (!from) return null;
  return `${from} â†’ ${to}`;
}

function FeeRow({ label, value, price, colorKey, extra, meta }) {
  const col = FEE_COLORS[colorKey] || {};
  const barW = price > 0 ? Math.min((Math.abs(value) / price) * 100, 100) : 0;
  const dateRange = rateDateRange(meta);
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1">
        <div className="flex items-center justify-between text-sm mb-1">
          <div className="flex items-center gap-2">
            <span className={`font-medium ${col.text || 'text-ink'}`}>{label}</span>
            {extra && <span className="text-[10px] text-outline bg-surface-container px-1.5 py-0.5 rounded">{extra}</span>}
          </div>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-ink">{currencyFull(Math.abs(value))}</span>
            <span className="text-[10px] text-outline w-10 text-right">{price > 0 ? pct(Math.abs(value) / price * 100) : 'â€”'}</span>
          </div>
        </div>
        <div className="h-2 bg-surface-container rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all duration-300"
            style={{ width: `${Math.max(barW, 0.5)}%`, backgroundColor: col.bar || '#94a3b8' }} />
        </div>
        {dateRange && (
          <p className="text-[10px] text-outline mt-1">Rate valid: {dateRange}</p>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-secondary mb-1.5 uppercase tracking-wide">{label}</label>
      {children}
    </div>
  );
}
