import { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import ExportButton from '../components/ExportButton';
import { useAnimatedDisplayValue } from '../hooks/useAnimatedDisplayValue';
import { useAuth } from '../context/AuthContext';
import useFetch from '../hooks/useFetch';
import {
  createAmazonRateRule,
  deleteAmazonRateRule,
  fetchAmazonReconciliation,
  updateAmazonRateRule,
} from '../api/client';
import { buildAmazonPaymentExport } from '../utils/exportXlsx';

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 2,
});

const EMPTY_RULE = {
  fee_code: 'fba_pick_pack', program: 'FBA', category: 'ALL', brand_name: 'Ethnic Juction',
  weight_slab: '', start_date: '', end_date: '', price_min: 0, price_max: 999999,
  calculation_basis: 'per_unit', rate: '', tax_rate: 0.18, priority: 0, notes: '',
};

function amount(value) { return money.format(Number(value || 0)); }

function SummaryCard({ label, value, detail, tone = 'slate' }) {
  const tones = {
    slate: 'border-border bg-surface text-ink',
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    rose: 'border-rose-200 bg-rose-50 text-rose-900',
  };
  const animatedValue = useAnimatedDisplayValue(value);
  return (
    <div className={`rounded-xl border p-4 ${tones[tone] || tones.slate}`}>
      <p className="text-[11px] font-bold uppercase tracking-[0.11em] opacity-60">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums">{animatedValue}</p>
      {detail && <p className="mt-1 text-xs opacity-70">{detail}</p>}
    </div>
  );
}

function statusStyle(status) {
  const styles = {
    matched: 'bg-emerald-100 text-emerald-700',
    overcharged: 'bg-rose-100 text-rose-700',
    undercharged: 'bg-sky-100 text-sky-700',
    not_configured: 'bg-amber-100 text-amber-700',
    return_review: 'bg-violet-100 text-violet-700',
    not_applicable: 'bg-surface-container text-secondary',
  };
  return styles[status] || styles.not_applicable;
}

function StatusPill({ status }) {
  const label = {
    matched: 'Matched', overcharged: 'Potential overcharge', undercharged: 'Below rate',
    not_configured: 'Rate needed', return_review: 'Return review', not_applicable: '—',
  }[status] || status;
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${statusStyle(status)}`}>{label}</span>;
}

function FeeSummary({ rows }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full min-w-[760px] text-xs">
        <thead className="border-b border-border bg-surface-container-low text-left text-secondary">
          <tr>
            <th className="px-4 py-3 font-semibold">Fee parameter</th>
            <th className="px-4 py-3 text-right font-semibold">Actual base</th>
            <th className="px-4 py-3 text-right font-semibold">GST</th>
            <th className="px-4 py-3 text-right font-semibold">Credits</th>
            <th className="px-4 py-3 text-right font-semibold">Net charged</th>
            <th className="px-4 py-3 text-right font-semibold">Expected</th>
            <th className="px-4 py-3 text-right font-semibold">Variance</th>
            <th className="px-4 py-3 text-right font-semibold">Coverage</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map(row => (
            <tr key={row.code} className="hover:bg-surface-container-low/70">
              <td className="px-4 py-3 font-semibold text-ink">{row.label}</td>
              <td className="px-4 py-3 text-right text-secondary">{amount(row.actualBase)}</td>
              <td className="px-4 py-3 text-right text-secondary">{amount(row.actualTax)}</td>
              <td className="px-4 py-3 text-right text-emerald-700">{amount(row.credits)}</td>
              <td className="px-4 py-3 text-right font-semibold text-ink">{amount(row.actualTotal)}</td>
              <td className="px-4 py-3 text-right text-secondary">{row.configuredLines ? amount(row.expectedTotal) : 'Not configured'}</td>
              <td className={`px-4 py-3 text-right font-semibold ${row.variance > 0.01 ? 'text-rose-600' : row.variance < -0.01 ? 'text-sky-600' : 'text-secondary'}`}>
                {row.configuredLines ? amount(row.variance) : '—'}
              </td>
              <td className="px-4 py-3 text-right text-secondary">{row.configuredLines}/{row.chargeLines || 0} lines</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RuleForm({ catalog, initialRule, onSave, onCancel, saving }) {
  const [form, setForm] = useState(initialRule || EMPTY_RULE);
  useEffect(() => setForm(initialRule || EMPTY_RULE), [initialRule]);
  const patch = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const selected = catalog.find(item => item.code === form.fee_code);

  const submit = event => {
    event.preventDefault();
    onSave({
      ...form,
      rate: Number(form.rate), tax_rate: Number(form.tax_rate), priority: Number(form.priority || 0),
      price_min: Number(form.price_min || 0), price_max: Number(form.price_max || 999999),
    });
  };

  return (
    <form onSubmit={submit} className="rounded-xl border border-primary bg-indigo-50/40 p-4">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-bold text-ink">{initialRule?.id ? 'Edit Amazon rate parameter' : 'Add Amazon rate parameter'}</h3>
          <p className="mt-0.5 text-xs text-secondary">Use only your verified Amazon rate card. GST is calculated separately on the fee base.</p>
        </div>
        {initialRule?.id && <button type="button" onClick={onCancel} className="text-xs font-semibold text-secondary hover:text-ink">Cancel edit</button>}
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Field label="Fee parameter">
          <select value={form.fee_code} onChange={e => {
            const next = catalog.find(item => item.code === e.target.value);
            setForm(current => ({ ...current, fee_code: e.target.value, program: next?.programs?.includes(current.program) ? current.program : (next?.programs?.[0] || 'ALL'), calculation_basis: next?.defaultBasis || current.calculation_basis }));
          }} className="input">
            {catalog.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}
          </select>
        </Field>
        <Field label="Program">
          <select value={form.program} onChange={e => patch('program', e.target.value)} className="input">
            {['ALL', 'FBA', 'FLEX'].filter(program => program === 'ALL' || selected?.programs?.includes(program)).map(program => <option key={program} value={program}>{program}</option>)}
          </select>
        </Field>
        <Field label="Calculation">
          <select value={form.calculation_basis} onChange={e => patch('calculation_basis', e.target.value)} className="input">
            <option value="per_unit">₹ per unit</option>
            <option value="per_order_line">₹ per order line</option>
            <option value="percent_of_sale">% of sale value</option>
          </select>
        </Field>
        <Field label={form.calculation_basis === 'percent_of_sale' ? 'Rate (0.15 = 15%)' : 'Fee rate (₹)'}>
          <input required min="0" step="0.0001" type="number" value={form.rate} onChange={e => patch('rate', e.target.value)} className="input" />
        </Field>
        <Field label="GST rate (0.18 = 18%)">
          <input required min="0" max="1" step="0.0001" type="number" value={form.tax_rate} onChange={e => patch('tax_rate', e.target.value)} className="input" />
        </Field>
        <Field label="Sale value from ₹">
          <input min="0" step="0.01" type="number" value={form.price_min} onChange={e => patch('price_min', e.target.value)} className="input" />
        </Field>
        <Field label="Sale value to ₹">
          <input min="0" step="0.01" type="number" value={form.price_max} onChange={e => patch('price_max', e.target.value)} className="input" />
        </Field>
        <Field label="Weight slab (optional)">
          <input value={form.weight_slab || ''} onChange={e => patch('weight_slab', e.target.value)} placeholder="e.g. 0.5–1 kg" className="input" />
        </Field>
        <Field label="Category (ALL = any)">
          <input value={form.category || 'ALL'} onChange={e => patch('category', e.target.value)} className="input" />
        </Field>
        <Field label="Effective from">
          <input type="date" value={form.start_date || ''} onChange={e => patch('start_date', e.target.value)} className="input" />
        </Field>
        <Field label="Effective to (optional)">
          <input type="date" value={form.end_date || ''} onChange={e => patch('end_date', e.target.value)} className="input" />
        </Field>
        <Field label="Notes (optional)">
          <input value={form.notes || ''} onChange={e => patch('notes', e.target.value)} placeholder="Rate card reference" className="input" />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        {initialRule?.id && <button type="button" onClick={onCancel} className="rounded-lg border border-border bg-surface px-3 py-2 text-xs font-semibold text-secondary">Cancel</button>}
        <button disabled={saving} className="rounded-lg bg-primary px-4 py-2 text-xs font-bold text-white hover:bg-primary disabled:opacity-60">
          {saving ? 'Saving…' : initialRule?.id ? 'Save change' : 'Add rate parameter'}
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }) {
  return <label className="block text-[11px] font-semibold text-secondary">{label}<div className="mt-1">{children}</div></label>;
}

function RuleTable({ rules, onEdit, onDelete, deleting }) {
  if (!rules.length) return <p className="rounded-xl border border-dashed border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">No verified Amazon rate parameters yet. Actual settlement charges are visible, but expected-fee comparison will start only after you add the applicable rules.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full min-w-[850px] text-xs">
        <thead className="border-b border-border bg-surface-container-low text-left text-secondary"><tr>
          <th className="px-3 py-2.5">Fee</th><th className="px-3 py-2.5">Program</th><th className="px-3 py-2.5">Basis</th><th className="px-3 py-2.5 text-right">Rate</th><th className="px-3 py-2.5 text-right">GST</th><th className="px-3 py-2.5">Sale / weight scope</th><th className="px-3 py-2.5">Effective period</th><th className="px-3 py-2.5" />
        </tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rules.map(rule => <tr key={rule.id}>
            <td className="px-3 py-2.5 font-semibold text-ink">{rule.fee_code.replaceAll('_', ' ')}</td>
            <td className="px-3 py-2.5 text-secondary">{rule.program}</td>
            <td className="px-3 py-2.5 text-secondary">{rule.calculation_basis.replaceAll('_', ' ')}</td>
            <td className="px-3 py-2.5 text-right text-ink">{rule.calculation_basis === 'percent_of_sale' ? `${(Number(rule.rate) * 100).toFixed(2)}%` : amount(rule.rate)}</td>
            <td className="px-3 py-2.5 text-right text-secondary">{(Number(rule.tax_rate) * 100).toFixed(0)}%</td>
            <td className="px-3 py-2.5 text-secondary">₹{rule.price_min}–{Number(rule.price_max) >= 999999 ? '∞' : `₹${rule.price_max}`}{rule.weight_slab ? ` · ${rule.weight_slab}` : ''}</td>
            <td className="px-3 py-2.5 text-secondary">{rule.start_date || 'Any'} → {rule.end_date || 'Ongoing'}</td>
            <td className="px-3 py-2.5 text-right whitespace-nowrap"><button onClick={() => onEdit(rule)} className="mr-3 font-semibold text-primary hover:text-primary">Edit</button><button disabled={deleting === rule.id} onClick={() => onDelete(rule)} className="font-semibold text-rose-600 hover:text-rose-800 disabled:opacity-50">{deleting === rule.id ? 'Removing…' : 'Remove'}</button></td>
          </tr>)}
        </tbody>
      </table>
    </div>
  );
}

export function AmazonReconciliationPanel({ embedded = false }) {
  const { user } = useAuth();
  const [month, setMonth] = useState('latest');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [actionError, setActionError] = useState('');
  const isAdmin = user?.role === 'admin';

  const request = useMemo(() => ({
    ...(month && month !== 'latest' ? { month } : {}),
    ...(month === 'latest' ? { latest: true } : {}),
    page,
    pageSize: 100,
  }), [month, page]);
  const { data, loading, error: reportError, refetch } = useFetch(
    () => fetchAmazonReconciliation(request),
    [month, page],
  );
  const error = actionError || reportError;
  const renderedPage = data?.pagination?.page || page;
  const refreshReport = () => {
    setActionError('');
    if (page === 1) refetch();
    else setPage(1);
  };
  const selectMonth = value => {
    setActionError('');
    setPage(1);
    setMonth(value);
  };

  const saveRule = async values => {
    setSaving(true); setActionError('');
    try {
      if (editing?.id) await updateAmazonRateRule(editing.id, values);
      else await createAmazonRateRule(values);
      setEditing(null);
      refreshReport();
    } catch (err) {
      setActionError(err?.response?.data?.error || err.message || 'Could not save the rate parameter');
    } finally { setSaving(false); }
  };
  const removeRule = async rule => {
    if (!window.confirm(`Remove the ${rule.fee_code.replaceAll('_', ' ')} rule?`)) return;
    setDeleting(rule.id); setActionError('');
    try { await deleteAmazonRateRule(rule.id); refreshReport(); }
    catch (err) { setActionError(err?.response?.data?.error || err.message || 'Could not remove the rate parameter'); }
    finally { setDeleting(null); }
  };
  const currentRows = data?.rows || [];
  const totalPages = Math.max(1, Math.ceil((data?.pagination?.total || 0) / (data?.pagination?.pageSize || 100)));
  const nonZeroFeeCodes = useMemo(() => new Set((data?.feeBreakdown || []).filter(row => row.actualTotal > 0 || row.credits > 0).map(row => row.code)), [data]);

  return (
    <div className="space-y-5">
      {!embedded && <PageHeader title="Amazon Payment Reconciliation" subtitle="Actual settlement ledger, verified rate parameters, and fee variance by order line." />}
      <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs leading-relaxed text-blue-900">
        <b>How it works:</b> Principal + Product Tax is the sale value. Shipping and shipping tax are shown against their discount lines. FBA uses Pick & Pack; Flex uses Technology Fee. Weight handling, closing fee, GST, TCS/TDS, returns, and fulfilment-fee credits stay separate. Return rows are marked for review instead of being falsely compared to a full-sale rate.
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border border-border bg-surface p-4">
        <label className="block text-xs font-semibold text-secondary">Settlement month
          <input type="month" value={month === 'latest' ? '' : month} onChange={event => selectMonth(event.target.value || '')} className="input mt-1 w-44" />
          <span className="mt-1 block text-[11px] font-normal text-secondary">{month === 'latest' ? 'Latest uploaded month' : month ? 'Selected month' : 'All uploaded data'}</span>
        </label>
        <div className="flex flex-wrap gap-2"><ExportButton label="Download visible payment check" disabled={loading || !data?.rows?.length} buildExport={() => buildAmazonPaymentExport(data, month === 'latest' ? 'latest-settlement-month' : month)} /><button onClick={() => selectMonth('latest')} className="rounded-lg border border-border px-3 py-2 text-xs font-semibold text-secondary hover:bg-surface-container-low">Latest month</button><button onClick={() => selectMonth('')} className="rounded-lg border border-border px-3 py-2 text-xs font-semibold text-secondary hover:bg-surface-container-low">All data</button><button onClick={refreshReport} disabled={loading} className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white disabled:opacity-60">{loading ? 'Refreshing…' : 'Refresh'}</button></div>
      </div>
      {loading && data && <p className="text-xs font-medium text-secondary">Refreshing the selected payment report. The last verified report remains visible.</p>}
      {error && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><span>{data ? `Showing the last verified payment report. Refresh failed: ${error}` : error}</span>{data && <button type="button" onClick={refreshReport} className="rounded-md border border-amber-300 bg-surface px-3 py-1.5 text-xs font-bold text-amber-900 hover:bg-amber-100">Retry</button>}</div>}
      {loading && !data ? <div className="rounded-xl border border-border bg-surface p-10 text-center text-sm text-secondary">Loading Amazon settlement ledger…</div> : data && <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <SummaryCard label="Sale value" value={amount(data.summary.grossSales)} detail={`${data.summary.saleLines.toLocaleString()} sale lines`} />
          <SummaryCard label="Actual fee charges" value={amount(data.summary.actualFees)} detail="After fee credits" tone="amber" />
          <SummaryCard label="Expected charges" value={amount(data.summary.expectedFees)} detail={`${data.summary.configuredComparisons.toLocaleString()} configured comparisons`} tone="emerald" />
          <SummaryCard label="Potential overcharge" value={amount(data.summary.potentialOvercharge)} detail="Only verified configured rules" tone="rose" />
          <SummaryCard label="Needs a rate" value={data.summary.unconfiguredCharges.toLocaleString()} detail={`${data.summary.fbaLines} FBA · ${data.summary.flexLines} Flex · ${data.summary.refundLines} return lines`} />
        </div>

        <section className="space-y-3"><div><h2 className="text-base font-bold text-ink">Fee parameter analysis</h2><p className="mt-1 text-xs text-secondary">Actual amounts include GST. Credits are kept separate so refund behaviour stays auditable.</p></div><FeeSummary rows={data.feeBreakdown.filter(row => nonZeroFeeCodes.has(row.code))} /></section>

        

        <section className="space-y-3"><div><h2 className="text-base font-bold text-ink">Order-line payment check</h2><p className="mt-1 text-xs text-secondary">This is the auditable output for a marketplace case: it shows raw payment logic by order and SKU.</p></div>
          <div className="overflow-x-auto rounded-xl border border-border bg-surface"><table className="w-full min-w-[1100px] text-xs"><thead className="border-b border-border bg-surface-container-low text-left text-secondary"><tr><th className="px-3 py-2.5">Order / SKU</th><th className="px-3 py-2.5">Program</th><th className="px-3 py-2.5 text-right">Sale value</th><th className="px-3 py-2.5 text-right">Net settled</th><th className="px-3 py-2.5">Fee details</th></tr></thead><tbody className="divide-y divide-slate-100">
            {currentRows.map(row => <tr key={`${row.order_id}-${row.sku || 'no-sku'}`} className="align-top hover:bg-surface-container-low/70"><td className="px-3 py-3"><p className="font-semibold text-ink">{row.order_id}</p><p className="mt-0.5 text-secondary">{row.sku || 'No SKU on payment line'} · Qty {row.quantity || 1}{row.has_refund ? ' · Refund' : ''}{row.has_fee_refund ? ' · Fee credit' : ''}</p></td><td className="px-3 py-3"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${row.program === 'FBA' ? 'bg-orange-100 text-orange-700' : row.program === 'FLEX' ? 'bg-cyan-100 text-cyan-700' : 'bg-violet-100 text-violet-700'}`}>{row.program}</span></td><td className="px-3 py-3 text-right font-semibold text-ink">{amount(row.sale_amount)}</td><td className="px-3 py-3 text-right font-semibold text-ink">{amount(row.net_settlement)}</td><td className="px-3 py-3"><div className="flex max-w-xl flex-wrap gap-1.5">{Object.values(row.fees).filter(fee => fee.actualTotal > 0 || fee.credits > 0).map(fee => <div key={fee.code} className="rounded-lg border border-border bg-surface px-2 py-1"><div className="flex items-center gap-1.5"><span className="font-semibold text-ink">{fee.label}</span><StatusPill status={fee.status} /></div><p className="mt-0.5 text-secondary">Actual {amount(fee.actualTotal)}{fee.expectedTotal != null ? ` · Expected ${amount(fee.expectedTotal)} · Δ ${amount(fee.variance)}` : fee.credits ? ` · Credit ${amount(fee.credits)}` : ''}</p></div>)}</div></td></tr>)}
          </tbody></table></div>
          <div className="flex items-center justify-between"><p className="text-xs text-secondary">Showing {currentRows.length ? (renderedPage - 1) * 100 + 1 : 0}–{Math.min(renderedPage * 100, data.pagination.total)} of {data.pagination.total.toLocaleString()} order lines</p><div className="flex gap-2"><button onClick={() => setPage(renderedPage - 1)} disabled={renderedPage <= 1 || loading} className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-secondary disabled:opacity-40">Previous</button><button onClick={() => setPage(renderedPage + 1)} disabled={renderedPage >= totalPages || loading} className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-secondary disabled:opacity-40">Next</button></div></div>
        </section>
      </>}
    </div>
  );
}

export default function AmazonReconciliationPage() {
  return <AmazonReconciliationPanel />;
}
