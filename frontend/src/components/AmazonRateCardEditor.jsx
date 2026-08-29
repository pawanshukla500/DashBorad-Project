import { useState, useEffect, useMemo } from 'react';
import { fetchAmazonRateRules, createAmazonRateRule, updateAmazonRateRule, deleteAmazonRateRule, fetchRateCardCategoryList } from '../api/client';
import { currency as amount } from '../utils/format';
import { useAuth } from '../context/AuthContext';

const TABS = [
  { id: 'commission', label: 'Commission', icon: '💰', color: 'bg-indigo-600', text: 'text-indigo-600' },
  { id: 'fixed_closing_fee', label: 'Fixed Closing Fee', icon: '🏷️', color: 'bg-violet-600', text: 'text-violet-600' },
  { id: 'fba_pick_pack', label: 'Pick & Pack (FBA)', icon: '📦', color: 'bg-cyan-600', text: 'text-cyan-600' },
  { id: 'fba_weight_handling', label: 'Weight Handling', icon: '⚖️', color: 'bg-rose-600', text: 'text-rose-600' },
  { id: 'technology_fee', label: 'Flex Tech Fee', icon: '💻', color: 'bg-blue-600', text: 'text-blue-600' },
  { id: 'return_processing_fee', label: 'Return Processing', icon: '🔄', color: 'bg-amber-600', text: 'text-amber-600' }
];

const EMPTY_RULE = {
  fee_code: 'commission', program: 'ALL', category: 'ALL', brand_name: '', weight_slab: '',
  start_date: '', end_date: '', price_min: 0, price_max: 999999,
  calculation_basis: 'per_unit', rate: '', tax_rate: 0.18, priority: 0, notes: '',
};

function Field({ label, children, flex }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-bold text-ink/80" style={{ flex }}>
      {label}
      {children}
    </label>
  );
}

function RuleForm({ catalog, tab, initialRule, onSave, onCancel, saving }) {
  const [form, setForm] = useState(() => ({
    ...(initialRule || EMPTY_RULE),
    fee_code: tab // auto-select the current tab fee code
  }));
  useEffect(() => {
    if (initialRule) setForm(initialRule);
    else setForm({ ...EMPTY_RULE, fee_code: tab });
  }, [initialRule, tab]);
  
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
    <form onSubmit={submit} className="rounded-xl border border-primary bg-indigo-50/40 p-4 mb-4">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-bold text-ink">{initialRule?.id ? 'Edit rate parameter' : 'Add rate parameter'}</h3>
          <p className="mt-0.5 text-xs text-secondary">Settings for {TABS.find(t => t.id === tab)?.label}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-4">
        <Field label="Fee type" flex="1 1 120px">
          <select value={form.fee_code} onChange={e => {
            const next = catalog.find(c => c.code === e.target.value);
            patch('fee_code', next.code);
            patch('program', next.programs.includes('ALL') ? 'ALL' : next.programs[0]);
            patch('calculation_basis', next.defaultBasis);
          }} className="input bg-white">
            {catalog.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Program" flex="1 1 100px">
          <select value={form.program} onChange={e => patch('program', e.target.value)} className="input bg-white" disabled={selected?.programs.length === 1}>
            {selected?.programs?.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="Category / FSN" flex="1 1 120px">
          <input value={form.category} onChange={e => patch('category', e.target.value)} placeholder="ALL" className="input uppercase bg-white" />
        </Field>
        <Field label="Brand" flex="1 1 120px">
          <input value={form.brand_name || ''} onChange={e => patch('brand_name', e.target.value)} placeholder="Any brand" className="input uppercase bg-white" />
        </Field>
        <Field label="Weight slab" flex="1 1 100px">
          <input value={form.weight_slab || ''} onChange={e => patch('weight_slab', e.target.value)} placeholder="e.g. 0.5kg" className="input bg-white" />
        </Field>
        <Field label="Basis" flex="1 1 120px">
          <select value={form.calculation_basis} onChange={e => patch('calculation_basis', e.target.value)} className="input bg-white">
            <option value="per_unit">Flat ₹ per unit</option>
            <option value="per_order_line">Flat ₹ per line</option>
            <option value="percent_of_sale">% of Sale Amount</option>
          </select>
        </Field>
        <Field label="From ₹" flex="1 1 80px">
          <input min="0" step="1" type="number" value={form.price_min} onChange={e => patch('price_min', e.target.value)} className="input bg-white" />
        </Field>
        <Field label="To ₹" flex="1 1 80px">
          <input min="0" step="1" type="number" value={form.price_max} onChange={e => patch('price_max', e.target.value)} className="input bg-white" />
        </Field>
        <Field label={form.calculation_basis === 'percent_of_sale' ? 'Rate (0.15 = 15%)' : 'Fee rate (₹)'} flex="1 1 100px">
          <input required min="0" step="0.0001" type="number" value={form.rate} onChange={e => patch('rate', e.target.value)} className="input bg-white font-mono text-primary" />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap gap-4 border-t border-border pt-4">
        <Field label="GST rate (0.18 = 18%)" flex="1 1 120px">
          <input required min="0" max="1" step="0.0001" type="number" value={form.tax_rate} onChange={e => patch('tax_rate', e.target.value)} className="input bg-white" />
        </Field>
        <Field label="Valid from" flex="1 1 120px">
          <input type="date" value={form.start_date || ''} onChange={e => patch('start_date', e.target.value)} className="input bg-white" />
        </Field>
        <Field label="Notes" flex="1 1 200px">
          <input value={form.notes || ''} onChange={e => patch('notes', e.target.value)} placeholder="Rate card reference" className="input bg-white" />
        </Field>
        <div className="flex-1 flex justify-end items-end gap-3 min-w-[200px]">
          <button type="button" onClick={onCancel} className="px-3 py-1.5 text-xs font-bold text-secondary hover:text-ink">Cancel</button>
          <button type="submit" disabled={saving} className="rounded-lg bg-primary px-5 py-2 text-xs font-bold text-white hover:bg-primary/90 disabled:opacity-50">
            {saving ? 'Saving…' : initialRule?.id ? 'Save change' : 'Add rate parameter'}
          </button>
        </div>
      </div>
    </form>
  );
}

function RuleTable({ rules, onEdit, onDelete, deleting }) {
  if (!rules.length) return <p className="p-8 text-center text-sm text-secondary">No configured rules for this fee type.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1000px] text-xs">
        <thead className="border-b border-border bg-surface-container-low text-left text-secondary">
          <tr>
            <th className="px-4 py-2.5">Program</th>
            <th className="px-4 py-2.5">Category / Brand</th>
            <th className="px-4 py-2.5">Sale Value / Weight</th>
            <th className="px-4 py-2.5">Basis</th>
            <th className="px-4 py-2.5 text-right font-bold text-ink">Rate</th>
            <th className="px-4 py-2.5">Effective</th>
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border font-medium">
          {rules.map(rule => (
            <tr key={rule.id} className={!rule.is_active ? 'opacity-50 bg-surface-container-lowest' : 'hover:bg-surface-container-low'}>
              <td className="px-4 py-3 text-ink font-bold">{rule.program}</td>
              <td className="px-4 py-3">
                <div className="text-ink uppercase">{rule.category}</div>
                {rule.brand_name && <div className="text-[10px] text-secondary font-mono">{rule.brand_name}</div>}
              </td>
              <td className="px-4 py-3 text-secondary">
                {rule.price_min > 0 || rule.price_max < 999999 ? `₹${rule.price_min} - ₹${rule.price_max}` : 'Any price'}
                {rule.weight_slab && <div className="text-xs text-ink">{rule.weight_slab}kg slab</div>}
              </td>
              <td className="px-4 py-3 text-secondary">{rule.calculation_basis}</td>
              <td className="px-4 py-3 text-right text-ink font-bold font-mono">
                {rule.calculation_basis === 'percent_of_sale' ? `${(Number(rule.rate) * 100).toFixed(2)}%` : amount(rule.rate)}
                <div className="text-[10px] text-secondary font-sans font-normal">+{(Number(rule.tax_rate) * 100).toFixed(0)}% GST</div>
              </td>
              <td className="px-4 py-3 text-secondary">
                {rule.start_date ? rule.start_date.slice(0,10) : 'Always'}
              </td>
              <td className="px-4 py-3 text-right">
                <button onClick={() => onEdit(rule)} className="px-3 py-1.5 text-xs font-bold text-primary hover:bg-surface-container rounded transition-colors mr-2">Edit</button>
                <button onClick={() => onDelete(rule)} disabled={deleting === rule.id} className="px-3 py-1.5 text-xs font-bold text-rose-600 hover:bg-rose-50 rounded transition-colors">Del</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AmazonRateCardEditor({ sellerAccount = 'default' }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [data, setData] = useState({ rules: [], feeCatalog: [] });
  const [categories, setCategories] = useState([]);
  const [tab, setTab] = useState('commission');
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [error, setError] = useState('');
  const [showMissing, setShowMissing] = useState(true);

  const loadData = () => {
    fetchAmazonRateRules(sellerAccount)
      .then(setData)
      .catch(err => setError(err.message));
    fetchRateCardCategoryList('amazon', sellerAccount, false)
      .then(res => setCategories(res.categories || []))
      .catch(console.error);
  };

  useEffect(() => { loadData(); }, [sellerAccount]);

  const saveRule = async (values) => {
    setSaving(true);
    setError('');
    try {
      if (editing?.id) await updateAmazonRateRule(editing.id, { ...values, seller_account: sellerAccount });
      else await createAmazonRateRule({ ...values, seller_account: sellerAccount });
      setEditing(null);
      loadData();
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Could not save the rate parameter');
    } finally {
      setSaving(false);
    }
  };

  const removeRule = async (rule) => {
    if (!window.confirm('Delete this rule?')) return;
    setDeleting(rule.id);
    setError('');
    try {
      await deleteAmazonRateRule(rule.id);
      loadData();
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Could not remove the rate parameter');
    } finally {
      setDeleting(null);
    }
  };

  const activeTabConfig = TABS.find(t => t.id === tab);
  const currentRules = data.rules.filter(r => r.fee_code === tab);
  
  // Calculate missing categories
  const missingCategories = useMemo(() => {
    const configuredCats = new Set(currentRules.map(r => r.category.toUpperCase()));
    if (configuredCats.has('ALL')) return []; // 'ALL' covers everything
    return categories.filter(c => c && !configuredCats.has(c.toUpperCase()));
  }, [categories, currentRules]);

  return (
    <div className="space-y-4">
      {/* Fee type tabs */}
      <div className="bg-surface rounded-2xl border border-border/80 shadow-sm overflow-hidden">
        <div className="border-b border-border px-3 pt-3 flex gap-1 flex-wrap bg-surface-container-low/40">
          {TABS.map(t => {
            const isAct = tab === t.id;
            const gapCnt = (t.id === tab) ? missingCategories.length : 0; // Only calculate for active tab for perf, or could calculate all
            return (
              <button key={t.id} onClick={() => { setTab(t.id); setEditing(null); }}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-t-xl transition-all ${
                  isAct
                    ? `${t.color} text-white -mb-px border border-b-white border-border`
                    : 'text-secondary hover:text-ink hover:bg-surface-container-low'
                }`}>
                <span>{t.icon}</span>
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="p-4 sm:p-6">
          {/* Missing Categories Panel */}
          {missingCategories.length > 0 && (
            <div className="mb-6 rounded-xl border border-orange-200 bg-orange-50/50 overflow-hidden">
              <button
                type="button"
                onClick={() => setShowMissing(!showMissing)}
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-orange-100/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-500 text-white shadow-sm">
                    {activeTabConfig.icon}
                  </div>
                  <h3 className="text-sm font-bold text-orange-950">
                    {missingCategories.length} categories missing {activeTabConfig.label}
                  </h3>
                </div>
                <span className="text-xs font-bold text-orange-600">{showMissing ? 'Hide' : 'Show'}</span>
              </button>
              
              {showMissing && (
                <div className="px-4 pb-4 border-t border-orange-100/80">
                  <p className="text-[11px] text-secondary py-2">
                    Missing {activeTabConfig.label.toLowerCase()} defaults to zero in reconciliation — configure each category or add an 'ALL' catch-all rule.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {missingCategories.map(cat => (
                      <div key={cat} className="rounded-lg border border-orange-200/80 bg-surface p-2.5">
                        <button
                          type="button"
                          onClick={() => { setEditing({ ...EMPTY_RULE, fee_code: tab, category: cat }); setShowMissing(false); }}
                          className="w-full flex items-center justify-between gap-2 text-left group"
                        >
                          <span className="text-xs font-semibold text-ink truncate uppercase">{cat}</span>
                          <span className="shrink-0 text-[10px] font-bold text-primary bg-primary-container px-2 py-0.5 rounded-md group-hover:bg-primary-container">
                            + Add
                          </span>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-bold text-ink">{activeTabConfig.label} Rates</h2>
            {isAdmin && !editing && (
              <button onClick={() => setEditing({ ...EMPTY_RULE, fee_code: tab })} className="rounded-full bg-primary px-4 py-2 text-xs font-bold text-white hover:bg-primary/90">
                + Add {activeTabConfig.label}
              </button>
            )}
          </div>

          {error && <div className="mb-4 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{error}</div>}

          {isAdmin && editing && (
            <RuleForm catalog={data.feeCatalog} tab={tab} initialRule={editing} onSave={saveRule} onCancel={() => setEditing(null)} saving={saving} />
          )}
          
          <div className="rounded-xl border border-border bg-surface overflow-hidden">
            <RuleTable rules={currentRules} onEdit={setEditing} onDelete={removeRule} deleting={deleting} />
          </div>
          
          {!isAdmin && <p className="mt-4 text-xs text-secondary text-center">Only an admin can change the verified rate parameters.</p>}
        </div>
      </div>
    </div>
  );
}
