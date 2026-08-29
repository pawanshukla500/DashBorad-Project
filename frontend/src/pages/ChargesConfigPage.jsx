import { useState, useCallback } from 'react';
import useFetch from '../hooks/useFetch';
import { fetchCharges, updateCharge, addCustomCharge, deleteCustomCharge } from '../api/client';

const CATEGORY_META = {
  marketplace_fee: { label: 'Marketplace Fees',    color: 'indigo' },
  logistics:       { label: 'Logistics',            color: 'sky'    },
  tax:             { label: 'Taxes & Government',   color: 'purple' },
  ads:             { label: 'Advertising',          color: 'orange' },
  storage:         { label: 'Storage',              color: 'amber'  },
  custom:          { label: 'Custom Charges',       color: 'emerald'},
};

const CATEGORY_ORDER = ['marketplace_fee','logistics','tax','ads','storage','custom'];

const CUSTOM_TYPE_LABELS = {
  per_order:      'Per Order (₹)',
  pct_revenue:    '% of Revenue',
  fixed_monthly:  'Fixed Monthly (₹)',
};

export default function ChargesConfigPage() {
  const [rev, setRev] = useState(0);
  const refresh = useCallback(() => setRev(r => r + 1), []);

  const { data: charges, loading } = useFetch(fetchCharges, [rev]);

  const grouped = {};
  (charges || []).forEach(c => {
    const cat = c.category in CATEGORY_META ? c.category : 'custom';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(c);
  });

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-bold text-ink">Charges Configuration</h1>
        <p className="text-sm text-outline mt-0.5">
          Control which fees and deductions appear in your P&L and Statement analysis. Toggle off charges you want to exclude from calculations.
        </p>
      </div>

      {loading && (
        <div className="space-y-4 animate-pulse">
          {[1,2,3].map(i => <div key={i} className="h-32 bg-surface-container rounded-xl" />)}
        </div>
      )}

      {!loading && (charges || []).length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center">
          <p className="text-amber-700 font-medium">No charges configured yet</p>
          <p className="text-amber-600 text-sm mt-1">Restart the backend to seed default charges.</p>
        </div>
      )}

      {!loading && CATEGORY_ORDER.filter(cat => grouped[cat]?.length).map(cat => (
        <CategorySection
          key={cat}
          cat={cat}
          charges={grouped[cat] || []}
          onRefresh={refresh}
        />
      ))}

      <AddCustomChargeForm onAdded={refresh} />
    </div>
  );
}

function CategorySection({ cat, charges, onRefresh }) {
  const meta = CATEGORY_META[cat] || { label: cat, color: 'slate' };
  const colorMap = {
    indigo:  { bg: 'bg-primary-container',  text: 'text-primary',  dot: 'bg-primary'  },
    sky:     { bg: 'bg-sky-50',     text: 'text-sky-700',     dot: 'bg-sky-500'     },
    purple:  { bg: 'bg-purple-50',  text: 'text-purple-700',  dot: 'bg-purple-500'  },
    orange:  { bg: 'bg-orange-50',  text: 'text-orange-700',  dot: 'bg-orange-500'  },
    amber:   { bg: 'bg-amber-50',   text: 'text-amber-700',   dot: 'bg-amber-500'   },
    emerald: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
    slate:   { bg: 'bg-surface-container-low',   text: 'text-ink',   dot: 'bg-surface-container-highest'   },
  }[meta.color];

  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      <div className={`px-5 py-3 border-b border-border flex items-center gap-2 ${colorMap.bg}`}>
        <div className={`w-2 h-2 rounded-full ${colorMap.dot}`} />
        <h3 className={`text-sm font-semibold ${colorMap.text}`}>{meta.label}</h3>
        <span className="ml-auto text-xs text-outline">
          {charges.filter(c => c.enabled).length}/{charges.length} enabled
        </span>
      </div>
      <div className="divide-y divide-slate-50">
        {charges.map(charge => (
          <ChargeRow key={charge.key} charge={charge} onRefresh={onRefresh} />
        ))}
      </div>
    </div>
  );
}

function ChargeRow({ charge, onRefresh }) {
  const [saving, setSaving] = useState(false);
  const [editLabel, setEditLabel] = useState(null);
  const [editType, setEditType]   = useState(charge.customType  || 'per_order');
  const [editValue, setEditValue] = useState(charge.customValue ?? '');

  async function toggle() {
    setSaving(true);
    try { await updateCharge(charge.key, { enabled: !charge.enabled }); onRefresh(); }
    finally { setSaving(false); }
  }

  async function saveCustom() {
    setSaving(true);
    try {
      await updateCharge(charge.key, {
        label: editLabel ?? charge.label,
        customType: editType,
        customValue: editValue !== '' ? +editValue : null,
      });
      setEditLabel(null);
      onRefresh();
    } finally { setSaving(false); }
  }

  async function remove() {
    if (!confirm(`Delete "${charge.label}"?`)) return;
    setSaving(true);
    try { await deleteCustomCharge(charge.key); onRefresh(); }
    finally { setSaving(false); }
  }

  const isCustom = charge.source === 'custom';

  return (
    <div className={`px-5 py-3.5 flex items-center gap-4 ${charge.enabled ? '' : 'opacity-50'}`}>
      {/* Toggle */}
      <button
        onClick={toggle}
        disabled={saving}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
          charge.enabled ? 'bg-primary' : 'bg-surface-container-high'
        } ${saving ? 'opacity-50' : ''}`}
      >
        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-surface shadow transition-transform ${
          charge.enabled ? 'translate-x-4' : 'translate-x-1'
        }`} />
      </button>

      {/* Label */}
      <div className="flex-1 min-w-0">
        {isCustom && editLabel !== null ? (
          <input
            value={editLabel}
            onChange={e => setEditLabel(e.target.value)}
            className="text-sm font-medium text-ink border-b border-primary outline-none bg-transparent w-full"
          />
        ) : (
          <p className="text-sm font-medium text-ink truncate">{charge.label}</p>
        )}
        <p className="text-[11px] text-outline font-mono">{charge.key}</p>
      </div>

      {/* Custom charge fields */}
      {isCustom && (
        <div className="flex items-center gap-2 shrink-0">
          <select
            value={editType}
            onChange={e => setEditType(e.target.value)}
            className="text-xs border border-border rounded-lg px-2 py-1 text-secondary bg-surface"
          >
            {Object.entries(CUSTOM_TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          <input
            type="number"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            placeholder="Amount"
            className="w-28 text-xs border border-border rounded-lg px-2 py-1 text-ink"
          />
          <button
            onClick={saveCustom}
            disabled={saving}
            className="px-2.5 py-1 bg-primary-container text-primary text-xs rounded-lg hover:bg-primary-container font-medium"
          >
            Save
          </button>
          <button
            onClick={() => setEditLabel(editLabel === null ? charge.label : null)}
            className="p-1 text-outline hover:text-secondary"
            title="Edit label"
          >
            <PencilIcon />
          </button>
          <button
            onClick={remove}
            disabled={saving}
            className="p-1 text-outline hover:text-rose-500"
            title="Delete charge"
          >
            <TrashIcon />
          </button>
        </div>
      )}

      {/* Source tag for data charges */}
      {!isCustom && (
        <span className="text-[10px] text-outline bg-surface-container px-2 py-0.5 rounded-full shrink-0">
          from data
        </span>
      )}
    </div>
  );
}

function AddCustomChargeForm({ onAdded }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel]       = useState('');
  const [key, setKey]           = useState('');
  const [customType, setType]   = useState('per_order');
  const [customValue, setValue] = useState('');
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!label.trim()) { setErr('Label is required'); return; }
    setSaving(true);
    setErr('');
    try {
      await addCustomCharge({
        key: key.trim() || label.trim().toLowerCase().replace(/[^a-z0-9]/g, '_'),
        label: label.trim(),
        customType,
        customValue: customValue !== '' ? +customValue : null,
      });
      setLabel(''); setKey(''); setValue('');
      setOpen(false);
      onAdded();
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-4 py-2.5 border-2 border-dashed border-border rounded-xl text-sm text-secondary hover:border-primary hover:text-primary w-full transition-colors"
      >
        <PlusIcon />
        Add Custom Charge (e.g. packaging, labour, storage)
      </button>
    );
  }

  return (
    <div className="bg-surface rounded-xl border border-border p-5 space-y-4">
      <h3 className="text-sm font-semibold text-ink">New Custom Charge</h3>
      <form onSubmit={submit} className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] text-secondary font-medium uppercase tracking-wide">Label *</label>
          <input
            value={label}
            onChange={e => { setLabel(e.target.value); setKey(e.target.value.toLowerCase().replace(/[^a-z0-9]/g,'_')); }}
            placeholder="e.g. Packaging Materials"
            className="mt-1 w-full border border-border rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-primary"
          />
        </div>
        <div>
          <label className="text-[11px] text-secondary font-medium uppercase tracking-wide">Key (auto)</label>
          <input
            value={key}
            onChange={e => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g,''))}
            placeholder="packaging_materials"
            className="mt-1 w-full border border-border rounded-lg px-3 py-2 text-sm text-outline bg-surface-container-low focus:outline-none focus:border-primary"
          />
        </div>
        <div>
          <label className="text-[11px] text-secondary font-medium uppercase tracking-wide">Calculation Type</label>
          <select
            value={customType}
            onChange={e => setType(e.target.value)}
            className="mt-1 w-full border border-border rounded-lg px-3 py-2 text-sm text-ink bg-surface focus:outline-none focus:border-primary"
          >
            {Object.entries(CUSTOM_TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[11px] text-secondary font-medium uppercase tracking-wide">
            {customType === 'pct_revenue' ? 'Rate (%)' : 'Amount (₹)'}
          </label>
          <input
            type="number"
            value={customValue}
            onChange={e => setValue(e.target.value)}
            placeholder={customType === 'pct_revenue' ? '2.5' : '5000'}
            className="mt-1 w-full border border-border rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-primary"
          />
        </div>
        {err && <p className="col-span-2 text-xs text-rose-600">{err}</p>}
        <div className="col-span-2 flex justify-end gap-2">
          <button type="button" onClick={() => setOpen(false)} className="px-4 py-2 text-sm text-secondary hover:text-ink">
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Add Charge'}
          </button>
        </div>
      </form>
    </div>
  );
}

function PencilIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}
