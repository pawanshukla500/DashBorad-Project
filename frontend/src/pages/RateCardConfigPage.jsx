import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import PageHeader from '../components/PageHeader';
import Modal, { ConfirmDialog } from '../components/Modal';
import {
  fetchRateCardConfig, fetchRateCardCategoryList, saveRateCardPeriod,
  deleteRateCardRow, seedRateCard, parseRateCardImage,
  fetchMarketplaceAccounts, createMarketplaceAccount, deleteMarketplaceAccount,
  fetchFilters, backfillBrands, fetchRateCardVersions, createRateCardVersion,
  publishRateCardVersion, rollbackRateCardVersion,
  fetchRateCardNotificationStatus, sendRateCardNotificationTest,
} from '../api/client';

/* ─── Date helpers ────────────────────────────────────────────────
   PostgreSQL DATE columns can come back as ISO strings with a UTC
   time component, e.g. "2026-03-25T18:30:00.000Z". In IST (+5:30)
   that renders as 26 Mar locally — but .slice(0,10) gives "2026-03-25"
   (1 day behind). toDateStr() always returns the LOCAL calendar date.
──────────────────────────────────────────────────────────────────── */
function toDateStr(d) {
  if (!d) return null;
  const s = String(d).trim();
  if (!s) return null;
  // Already a plain YYYY-MM-DD — use as-is, no timezone math needed
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dt = new Date(s);
  // Any input the JS Date parser cannot interpret (e.g. the literal
  // 'no-date' fallback key, malformed strings, or non-date placeholders)
  // must surface as null so callers can decide on a label instead of
  // getting a partial / unparseable string back.
  if (isNaN(dt)) return null;
  // Format in LOCAL timezone (getFullYear/Month/Date, not UTC equivalents)
  const y  = dt.getFullYear();
  const m  = String(dt.getMonth() + 1).padStart(2, '0');
  const dy = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

// `toDateStr` formats in the user's local timezone, which is what every form
// date input and `rowStatus` check expects. `new Date().toISOString().slice(0,10)`
// is UTC-truncated and can be off by a day for IST users at midnight.
const TODAY = toDateStr(new Date());

function getTomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return toDateStr(d);
}
function dateMinus1(s) {
  const [y, m, dy] = s.split('-').map(Number);
  const d = new Date(y, m - 1, dy);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
// `unknownText` — shown when a value is provided but unparseable, e.g. a
// legacy row that was created before start_date became mandatory. This is
// distinct from `null` (which historically means "ongoing / no end").
function fmtDate(d, { unknownText = '—' } = {}) {
  if (d == null || d === '') return 'Ongoing';
  const s = toDateStr(d);
  if (!s) return unknownText;
  const [y, mo, dy] = s.split('-').map(Number);
  // Guard against partial / non-numeric slices leaking through `toDateStr`
  // (defence-in-depth — the regex above should already catch them).
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(dy)) return unknownText;
  const dt = new Date(y, mo - 1, dy);
  if (isNaN(dt)) return unknownText;
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/* ─── Value display helpers ───────────────────────────────────── */
function fmtPriceRange(min, max) {
  const lo = Number.isFinite(+min) ? +min : 0;
  const hi = Number.isFinite(+max) ? +max : 999999;
  if (lo === 0 && hi >= 999990) return 'All prices';
  if (hi >= 999990) return `≥ ₹${lo.toLocaleString('en-IN')}`;
  if (lo === 0) return `₹0 – ₹${hi.toLocaleString('en-IN')}`;
  return `₹${lo.toLocaleString('en-IN')} – ₹${hi.toLocaleString('en-IN')}`;
}
function fmtVal(v) {
  const n = +v;
  if (n === 0) return '₹0';
  if (n > 0 && n < 1) {
    const pct = n * 100;
    return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2).replace(/0+$/, '')}%`;
  }
  return `₹${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
}
// For percentage-based rates (commission, collection_fee) where 0 means "0%", not "₹0"
// Treats floating-point noise within ±0.005% (|n| < 0.00005) as exactly 0%
function fmtPct(v) {
  const n = +v;
  if (Math.abs(n) < 0.0005) return '0%';   // absorbs floating-point noise (e.g. -0.0007 from AI parser)
  if (Math.abs(n) < 1) {
    const pct = n * 100;
    return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2).replace(/0+$/, '')}%`;
  }
  // Already stored as a percentage (e.g. 14 means 14%)
  return `${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}%`;
}
// Collection fee: FK mixes flat ₹0 and 0% in the same table — must distinguish
function fmtCollVal(v, type) {
  const n = +v;
  if (type === 'flat') return n === 0 ? '₹0' : `₹${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
  if (n === 0) return '0%';
  const pct = n * 100;
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2).replace(/0+$/, '')}%`;
}

/* ─── Row status (uses toDateStr to avoid timezone offset) ───── */
function rowStatus(row, date = TODAY) {
  const from = toDateStr(row.start_date);
  const to   = toDateStr(row.end_date);
  if (from && from > date) return 'future';
  if (to   && to   < date) return 'expired';
  return 'active';
}

/* ─── Marketplace definitions ─────────────────────────────────── */
// Shopsy is a sub-channel of Flipkart — its categories appear under Flipkart
// as "shopsy_kurta", "shopsy_ethnic_set" etc. (prefixed, not a separate marketplace).
const MARKETPLACES = [
  { id: 'flipkart', label: 'Flipkart',  emoji: '🛒', note: 'Includes Shopsy sub-channel (shopsy_* categories)' },
  { id: 'amazon',   label: 'Amazon',    emoji: '📦' },
  { id: 'meesho',   label: 'Meesho',    emoji: '🎀' },
  { id: 'myntra_vb', label: 'Myntra (VB)', emoji: '👗', defaultAccount: 'myntra_vb', note: 'VB Exports (Seller ID: 10708)' },
  { id: 'myntra_ej', label: 'Myntra (EJ)', emoji: '👗', defaultAccount: 'myntra_ej', note: 'EJ Account (Seller ID: 45833)' },
  { id: 'jiomart',  label: 'JioMart',   emoji: '🏪' },
];

/* ─── Fee type configuration ──────────────────────────────────── */
const FEE_CONFIGS = {
  commission: {
    title: 'Commission',
    icon: '💰',
    color: 'indigo',
    description: 'Charged as % of seller price by Order Item Value slab. Add brand-specific rows to override the generic rate.',
    tableHeaders: ['Brand', 'Order Item Value', 'Rate'],
    renderRow: r => [r.brand_name || 'All brands', fmtPriceRange(r.price_min, r.price_max), fmtPct(r.rate)],
    formFields: [
      { key: 'brand_name', label: 'Brand',  type: 'multi_brand', placeholder: 'All brands (generic rate)', flex: '1 1 160px',
        help: 'Leave empty = applies to all brands. Select multiple → saves one row per brand.' },
      { key: 'price_min',  label: 'From ₹', type: 'number', placeholder: '0',    flex: '1 1 70px', help: 'Slab starts at ₹' },
      { key: 'price_max',  label: 'To ₹',   type: 'number', placeholder: '∞',    flex: '1 1 70px', help: 'Leave blank = no upper limit' },
      { key: 'rate',       label: 'Rate',    type: 'number', placeholder: '0.14', flex: '1 1 80px', step: '0.0001',
        hint: 'Decimal: 0.14 = 14%, 0 = 0%', help: 'Enter as decimal: 14% → 0.14' },
    ],
    defaultSlab: () => ({ brand_name: [], price_min: '', price_max: '', rate: '' }),
    formHint: '💡 Commission rate as decimal — 0.14 = 14%, 0.05 = 5%, 0 = free. Add brand rows for brand-specific rates.',
  },
  fixed_fee: {
    title: 'Fixed Fee',
    icon: '🏷️',
    color: 'violet',
    description: 'Flat ₹ per successful sale. Depends on seller tier (Bronze / Silver / Gold / Diamond).',
    tableHeaders: ['Seller Tier', 'Order Item Value', 'Fee (₹)'],
    renderRow: r => [r.fulfilment_type || 'All', fmtPriceRange(r.price_min, r.price_max), fmtVal(r.rate)],
    formFields: [
      { key: 'fulfilment_type', label: 'Seller Tier', type: 'select',
        options: ['Bronze', 'Silver', 'Gold', 'Diamond', 'All'], help: 'Your current seller tier' },
      { key: 'price_min', label: 'From ₹',  type: 'number', placeholder: '0'  },
      { key: 'price_max', label: 'To ₹',    type: 'number', placeholder: '∞'  },
      { key: 'rate',      label: 'Fee (₹)', type: 'number', placeholder: '6', step: '0.01',
        help: 'Flat rupee amount charged per order' },
    ],
    defaultSlab: () => ({ fulfilment_type: 'Silver', price_min: '', price_max: '', rate: '' }),
    formHint: '💡 Add one row per tier — e.g. Silver ₹6, Gold ₹4',
  },
  collection_fee: {
    title: 'Collection Fee',
    icon: '💳',
    color: 'blue',
    description: 'Payment collection charges. FK mixes flat ₹ and % in the same table — use the ₹/% toggle per slab.',
    tableHeaders: ['Fulfilment', 'Order Item Value', 'Prepaid', 'Postpaid (COD)'],
    renderRow: r => [
      r.fulfilment_type || 'All',
      fmtPriceRange(r.price_min, r.price_max),
      fmtCollVal(r.prepaid,  r.prepaid_type  || 'pct'),
      fmtCollVal(r.postpaid, r.postpaid_type || 'pct'),
    ],
    formFields: [
      { key: 'fulfilment_type', label: 'Fulfilment', type: 'select',
        options: ['All', 'FBF', 'Non-FBF', 'Self-Ship'], flex: '1 1 90px', help: 'FBF/Non-FBF if rates differ' },
      { key: 'price_min',  label: 'From ₹',        type: 'number', placeholder: '0',   flex: '1 1 70px' },
      { key: 'price_max',  label: 'To ₹',          type: 'number', placeholder: '∞',   flex: '1 1 70px' },
      { key: 'prepaid',    label: 'Prepaid',        type: 'number', placeholder: '0', step: '0.0001', flex: '1 1 80px',
        help: '% as decimal (0.003 = 0.3%) or flat ₹' },
      { key: 'prepaid_type',  label: 'Type', type: 'rate_type', flex: '0 0 60px' },
      { key: 'postpaid',   label: 'Postpaid (COD)', type: 'number', placeholder: '0', step: '0.0001', flex: '1 1 80px' },
      { key: 'postpaid_type', label: 'Type', type: 'rate_type', flex: '0 0 60px' },
    ],
    defaultSlab: () => ({ fulfilment_type: 'All', price_min: '', price_max: '',
      prepaid: '', postpaid: '', prepaid_type: 'pct', postpaid_type: 'pct' }),
    formHint: '💡 Toggle ₹/% per slab — FK uses ₹0 flat for some slabs and 0% for others (they differ!). % as decimal: 0.003 = 0.3%.',
  },
  pick_pack: {
    title: 'Pick & Pack',
    icon: '📦',
    color: 'cyan',
    description: 'Fulfillment fee per order. Use Fulfilment Type to differentiate FBA vs Flex vs FBF rates.',
    tableHeaders: ['Fulfilment Type', 'Order Item Value', 'Fee (₹)'],
    renderRow: r => [r.fulfilment_type || 'ALL', fmtPriceRange(r.price_min, r.price_max), fmtVal(r.rate)],
    formFields: [
      { key: 'fulfilment_type', label: 'Fulfilment Type', type: 'select',
        options: ['ALL','FBF','NON_FBF','FBA','FLEX','EASY_SHIP','SELF_SHIP'],
        help: 'ALL = applies to all types · FBA/FLEX for Amazon · FBF/NON_FBF for Flipkart' },
      { key: 'price_min', label: 'From ₹',  type: 'number', placeholder: '0' },
      { key: 'price_max', label: 'To ₹',    type: 'number', placeholder: '∞' },
      { key: 'rate',      label: 'Fee (₹)', type: 'number', placeholder: '0', step: '0.01',
        help: 'Flat ₹ charged per order for this fulfilment type' },
    ],
    defaultSlab: () => ({ fulfilment_type: 'ALL', price_min: '', price_max: '', rate: '' }),
    formHint: '💡 For Amazon: add FBA row (₹37–87) and FLEX row (₹30–78) separately per category. For Flipkart: use FBF / NON_FBF.',
  },
  reverse_shipping: {
    title: 'Reverse Shipping',
    icon: '🔄',
    color: 'rose',
    description: 'Return pick-up charges. The matched rate uses order-item value, weight slab, and delivery zone.',
    tableHeaders: ['Order Item Value', 'Weight Slab', 'Local (₹)', 'Zonal (₹)', 'National (₹)'],
    renderRow: r => [fmtPriceRange(r.price_min, r.price_max), r.weight_slab || '—', fmtVal(r.local_fee), fmtVal(r.zonal_fee), fmtVal(r.national_fee)],
    formFields: [
      { key: 'price_min', label: 'From ₹', type: 'number', placeholder: '0', flex: '1 1 70px',
        help: 'Order item value starts at this amount' },
      { key: 'price_max', label: 'To ₹', type: 'number', placeholder: 'No limit', flex: '1 1 70px',
        help: 'Leave blank when the band has no upper limit' },
      { key: 'weight_slab',  label: 'Weight Slab',  type: 'text',   placeholder: 'e.g. 0–0.5 kg',
        help: 'e.g. 0-0.5kg / 0.5-1kg / 1-1.5kg' },
      { key: 'local_fee',    label: 'Local (₹)',    type: 'number', placeholder: '102', step: '0.01' },
      { key: 'zonal_fee',    label: 'Zonal (₹)',    type: 'number', placeholder: '122', step: '0.01' },
      { key: 'national_fee', label: 'National (₹)', type: 'number', placeholder: '162', step: '0.01',
        help: 'Highest charge — cross-state delivery' },
    ],
    defaultSlab: () => ({ price_min: '', price_max: '', weight_slab: '', local_fee: '', zonal_fee: '', national_fee: '' }),
    formHint: '💡 Add one row per order-value and weight band. Example: ₹0–500 / 0–0.5 kg, then ₹501+ / 0–0.5 kg.',
  },
  franchise_fee: {
    title: 'Franchise Fee',
    icon: '🏢',
    color: 'amber',
    description: 'Flat ₹ per order franchise fee charged by Flipkart for specific brands or categories. Included in GST basis.',
    tableHeaders: ['Category', 'Brand', 'Order Item Value', 'Fee (₹)'],
    renderRow: r => [r.category || 'ALL', r.brand_name || 'All brands', fmtPriceRange(r.price_min, r.price_max), fmtVal(r.rate)],
    formFields: [
      { key: 'brand_name', label: 'Brand',   type: 'text', placeholder: 'Pick or type brand…', flex: '1 1 150px',
        help: 'Leave blank = all brands under this category' },
      { key: 'price_min',  label: 'From ₹',  type: 'number', placeholder: '0',     flex: '1 1 70px' },
      { key: 'price_max',  label: 'To ₹',    type: 'number', placeholder: '∞',     flex: '1 1 70px' },
      { key: 'rate',       label: 'Fee (₹)', type: 'number', placeholder: '25.50', flex: '1 1 80px', step: '0.01',
        help: 'Flat ₹ charged per order as franchise fee' },
    ],
    defaultSlab: () => ({ brand_name: '', price_min: '', price_max: '', rate: '' }),
    formHint: '💡 Set brand-specific franchise fee — e.g. Youthnic = ₹25.50. Leave brand blank for a catch-all rate.',
  },
};

const TABS = ['commission', 'fixed_fee', 'collection_fee', 'pick_pack', 'reverse_shipping', 'franchise_fee'];
const TAB_COLORS = {
  commission: 'indigo',
  fixed_fee: 'violet',
  collection_fee: 'blue',
  pick_pack: 'cyan',
  reverse_shipping: 'rose',
  franchise_fee: 'amber'
};

const ACTIVE_MAP = {
  indigo: 'bg-indigo-600 text-white',
  violet: 'bg-violet-600 text-white',
  blue: 'bg-blue-600 text-white',
  cyan: 'bg-cyan-600 text-white',
  rose: 'bg-rose-600 text-white',
  amber: 'bg-amber-600 text-white',
  orange: 'bg-orange-600 text-white'
};


// Franchise fee is optional (not all categories charge it)
const REQUIRED_FEE_TYPES = ['commission', 'fixed_fee', 'collection_fee', 'pick_pack', 'reverse_shipping'];

/* ─── Status badge ────────────────────────────────────────────── */
function StatusBadge({ status }) {
  const MAP = {
    active:  { bg: 'bg-emerald-100', text: 'text-emerald-700', dot: 'bg-emerald-500', label: 'ACTIVE NOW' },
    expired: { bg: 'bg-surface-container',   text: 'text-secondary',   dot: 'bg-surface-container-highest',   label: 'EXPIRED' },
    future:  { bg: 'bg-blue-100',    text: 'text-blue-700',    dot: 'bg-blue-500',     label: 'UPCOMING' },
  };
  const s = MAP[status] || MAP.expired;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold ${s.bg} ${s.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

/* ─── Rate slab table ─────────────────────────────────────────── */
function RateSlabTable({ rows, config, compact = false }) {
  if (!rows || rows.length === 0) return null;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-border">
          {config.tableHeaders.map(h => (
            <th key={h} className={`text-left font-semibold text-secondary pr-6 ${compact ? 'py-1.5' : 'py-2'}`}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const cols = config.renderRow(r);
          return (
            <tr key={i} className="border-b border-border last:border-0 hover:bg-surface-container-low/50 transition-colors">
              {cols.map((c, j) => (
                <td key={j} className={`pr-6 ${compact ? 'py-1' : 'py-2'} ${j === cols.length - 1 ? 'font-bold text-ink' : 'text-secondary'}`}>
                  {c}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ─── Category card ───────────────────────────────────────────── */
function ModalSection({ step, title, children, className = '' }) {
  return (
    <section className={`rounded-xl border border-border/80 bg-surface-container-low/40 p-4 ${className}`}>
      <div className="flex items-center gap-2.5 mb-3">
        <span className="w-7 h-7 rounded-lg bg-primary text-white text-xs font-bold flex items-center justify-center shadow-sm shrink-0">
          {step}
        </span>
        <h3 className="text-sm font-bold text-ink">{title}</h3>
      </div>
      {children}
    </section>
  );
}

function CategoryCard({ category, allRows, config, onEdit, onEditPeriod, onCopyPeriod, onDelete }) {
  const [showHistory, setShowHistory] = useState(false);

  // Group rows by start_date period
  const periodMap = {};
  allRows.forEach(r => {
    const key = toDateStr(r.start_date) || 'no-date';
    if (!periodMap[key]) periodMap[key] = [];
    periodMap[key].push(r);
  });
  const sortedPeriods = Object.keys(periodMap).sort().reverse(); // newest first

  const activeRows = allRows.filter(r => rowStatus(r) === 'active');
  const activePeriodStart = activeRows.length > 0
    ? activeRows.reduce((min, r) => {
        const d = toDateStr(r.start_date);
        return (!min || (d && d < min)) ? d : min;
      }, null)
    : null;

  return (
    <div className="bg-surface rounded-xl border border-border/80 shadow-[0_2px_16px_-4px_rgba(15,23,42,0.06)] overflow-hidden hover:shadow-md transition-shadow">
      {/* Card header — clean white surface with a thin burgundy accent bar
          on the left so the category name reads as a strong, dark heading
          instead of being washed out against a pastel gradient. */}
      <div className="relative px-5 py-4 flex items-center justify-between gap-3 border-b border-border bg-surface">
        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-primary/85 rounded-r-sm" />
        <div className="pl-3">
          <h3 className="font-bold text-ink text-body-lg font-semibold">{category}</h3>
          {activePeriodStart ? (
            <p className="text-xs text-emerald-600 mt-0.5 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block animate-pulse" />
              Active from {fmtDate(activePeriodStart)}
            </p>
          ) : activeRows.length > 0 ? (
            // Active rules exist but none of them carry a parseable start_date
            // (legacy data). Be honest about it instead of telling the user to
            // "add a rate".
            <p className="text-xs text-amber-600 mt-0.5 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />
              Active period has no start date on file — backfill it for cleaner history
            </p>
          ) : (
            <p className="text-xs text-amber-600 mt-0.5 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />
              No active rate for today — add one!
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {sortedPeriods.length > 0 && (
            <button
              onClick={() => setShowHistory(v => !v)}
              className="text-xs px-3 py-1.5 border border-border text-secondary rounded-lg hover:bg-surface-container focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {showHistory ? 'Hide' : 'History'} ({sortedPeriods.length})
            </button>
          )}
          <button
            onClick={() => onEdit(category, activeRows)}
            className="text-xs px-4 py-1.5 bg-primary text-white rounded-lg hover:bg-primary/90 active:bg-primary focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 flex items-center gap-1.5 font-semibold shadow-sm transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Rate Period
          </button>
        </div>
      </div>

      {/* Active rates */}
      {activeRows.length > 0 ? (
        <div className="px-5 py-4">
          <RateSlabTable rows={activeRows} config={config} />
        </div>
      ) : (
        <div className="px-5 py-5 text-sm text-outline italic text-center">
          No active rates — click <strong className="text-primary not-italic">New Rate Period</strong> to add
        </div>
      )}

      {/* Rate history */}
      {showHistory && (
        <div className="border-t border-border divide-y divide-border bg-surface-container-low/60">
          {sortedPeriods.map(periodKey => {
            const pRows  = periodMap[periodKey];
            const st     = rowStatus(pRows[0]);
            const endStr = toDateStr(pRows[0].end_date);
            const startLabel = periodKey === 'no-date'
              ? 'No start date'
              : fmtDate(pRows[0].start_date);
            return (
              <div key={periodKey} className={`transition-colors ${st === 'active' ? 'bg-emerald-50/50' : ''}`}>
                <div className="px-5 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <StatusBadge status={st} />
                    <span className="text-xs text-secondary font-semibold">
                      {startLabel}
                      <span className="text-outline font-normal mx-1">→</span>
                      {fmtDate(endStr)}
                    </span>
                    <span className="text-[10px] text-outline">{pRows.length} row{pRows.length > 1 ? 's' : ''}</span>
                  </div>
                  <div className="flex items-center gap-2.5">
                    {/* ── Copy Period ── */}
                    <button
                      onClick={() => onCopyPeriod(category, pRows)}
                      className="flex items-center gap-1 text-[11px] text-outline hover:text-ink font-semibold transition-colors"
                      title="Copy these slabs to a new period or different category"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Copy
                    </button>
                    <span className="text-surface">|</span>
                    {/* ── Edit Period ── */}
                    <button
                      onClick={() => onEditPeriod(category, pRows)}
                      className="flex items-center gap-1 text-[11px] text-primary hover:text-primary font-semibold transition-colors"
                      title="Edit this period's dates and rates"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                      </svg>
                      Edit
                    </button>
                    <span className="text-surface">|</span>
                    <button
                      onClick={() => onDelete(pRows.map(r => r.id))}
                      className="text-[11px] text-rose-400 hover:text-rose-600 font-semibold transition-colors"
                      title="Delete this period from database"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <div className="px-5 pb-4">
                  <RateSlabTable rows={pRows} config={config} compact />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Category selector dropdown ──────────────────────────────── */
function CategorySelector({ marketplace, sellerAccount = 'default', value, onChange, disabled }) {
  const [cats, setCats]         = useState([]);
  const [catsLoading, setCatsL] = useState(false);
  const [addMode, setAddMode]   = useState(false);

  useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    setCatsL(true);
    fetchRateCardCategoryList(marketplace, sellerAccount)
      .then(d => { if (!cancelled) setCats(d.categories || []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setCatsL(false); });
    return () => { cancelled = true; };
  }, [marketplace, sellerAccount, disabled]);

  if (disabled) {
    return (
      <div className="bg-surface-container-low border border-border rounded-xl px-4 py-3 text-sm text-ink font-semibold flex items-center gap-2">
        <svg className="w-4 h-4 text-outline" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
        {value}
        <span className="text-[10px] text-outline ml-auto font-normal">locked while editing</span>
      </div>
    );
  }

  if (addMode) {
    return (
      <div className="space-y-2">
        <div className="flex gap-2">
          <input
            autoFocus
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder="Type new category name e.g. Ethnic Wear"
            className="flex-1 text-sm border-2 border-primary rounded-xl px-4 py-2.5 focus:ring-2 focus:ring-primary outline-none"
          />
          <button type="button" onClick={() => { setAddMode(false); onChange(''); }}
            className="px-3 py-2 text-xs border border-border rounded-xl text-secondary hover:bg-surface-container-low whitespace-nowrap">
            ← Back
          </button>
        </div>
        <p className="text-[11px] text-primary flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          New category will be created for {MARKETPLACES.find(m => m.id === marketplace)?.label || marketplace}
        </p>
      </div>
    );
  }

  return (
    <div className="relative">
      <select
        value={value || ''}
        onChange={e => {
          if (e.target.value === '__new__') { setAddMode(true); onChange(''); }
          else onChange(e.target.value);
        }}
        className="w-full text-sm border border-border rounded-xl px-4 py-3 pr-10 focus:ring-2 focus:ring-primary/50 focus:border-primary outline-none appearance-none bg-surface font-medium text-ink shadow-sm"
      >
        <option value="">Select a category from your orders…</option>
        {catsLoading && <option disabled>Loading…</option>}
        {cats.map(c => <option key={c} value={c}>{c}</option>)}
        <option disabled>──────────────</option>
        <option value="__new__">✚ Add new category…</option>
      </select>
      <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-outline pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </div>
  );
}

/* ─── Additional Categories Selector (multi-apply) ───────────────
   Lets user check multiple categories that share the same slabs.
   Only shown in Add / Copy mode (not edit mode).
──────────────────────────────────────────────────────────────────── */
function AdditionalCategoriesSelector({ marketplace, sellerAccount = 'default', primaryCategory, value, onChange }) {
  const [cats, setCats]  = useState([]);
  const [open, setOpen]  = useState(value.length > 0);
  const [loading, setLd] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLd(true);
    fetchRateCardCategoryList(marketplace, sellerAccount)
      .then(d => { if (!cancelled) setCats(d.categories || []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLd(false); });
    return () => { cancelled = true; };
  }, [open, marketplace, sellerAccount]);

  const available = cats.filter(c => c !== primaryCategory);

  if (!open && value.length === 0) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full text-left text-xs px-4 py-2.5 border-2 border-dashed border-border rounded-xl text-outline hover:border-primary hover:text-primary flex items-center gap-2 transition-colors group mt-2"
      >
        <svg className="w-4 h-4 group-hover:scale-110 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        Apply same slabs to multiple categories at once — click to select
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-xl border-2 border-primary bg-primary-container/40 p-3">
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-xs font-bold text-primary flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          Also apply to {value.length > 0 ? <span className="bg-primary text-white px-1.5 py-0.5 rounded-full text-[10px] ml-1">{value.length} selected</span> : 'other categories'}
        </span>
        <button
          type="button"
          onClick={() => { setOpen(false); onChange([]); }}
          className="inline-flex items-center gap-1 rounded-md text-[11px] font-medium text-outline transition-colors hover:text-rose-500 focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">close</span>
          Clear & close
        </button>
      </div>
      {loading ? (
        <p className="text-xs text-outline py-2 text-center">Loading categories…</p>
      ) : available.length === 0 ? (
        <p className="text-xs text-outline py-1 text-center">No other categories found for this marketplace</p>
      ) : (
        <div className="max-h-44 overflow-y-auto space-y-0.5 rounded-lg border border-primary bg-surface">
          {available.map(cat => {
            const checked = value.includes(cat);
            return (
              <label key={cat} className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors border-b border-border last:border-0 ${checked ? 'bg-primary-container' : 'hover:bg-surface-container-low'}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={e => onChange(e.target.checked ? [...value, cat] : value.filter(c => c !== cat))}
                  className="w-3.5 h-3.5 text-primary rounded border-border cursor-pointer"
                />
                <span className={`text-xs font-medium flex-1 ${checked ? 'text-primary' : 'text-secondary'}`}>{cat}</span>
                {checked && (
                  <span className="material-symbols-outlined shrink-0 text-[16px] text-primary" aria-hidden="true">check</span>
                )}
              </label>
            );
          })}
        </div>
      )}
      {value.length > 0 && (
        <div className="mt-2 pt-2 border-t border-primary flex flex-wrap gap-1.5">
          {value.map(cat => (
            <span key={cat} className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary text-white text-[10px] font-semibold rounded-full">
              {cat}
              <button type="button" onClick={() => onChange(value.filter(c => c !== cat))} aria-label={`Remove ${cat}`} className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full leading-none hover:text-red-300 focus-visible:ring-2 focus-visible:ring-white/80">
                <span className="material-symbols-outlined text-[12px]" aria-hidden="true">close</span>
              </button>
            </span>
          ))}
        </div>
      )}
      <p className="text-[10px] text-primary mt-2">
        💡 Rates will be saved separately for each category — same slabs, same dates, one click
      </p>
    </div>
  );
}

/* ─── FormHintTip — inline ℹ icon with hover tooltip ─────────────
   Replaces the yellow formHint block. Small, unobtrusive.
──────────────────────────────────────────────────────────────────── */
function FormHintTip({ hint }) {
  const [show, setShow] = useState(false);
  return (
    <div className="mt-2 flex justify-end">
      <div className="relative inline-block">
        <button
          type="button"
          onMouseEnter={() => setShow(true)}
          onMouseLeave={() => setShow(false)}
          onFocus={() => setShow(true)}
          onBlur={() => setShow(false)}
          className="flex items-center gap-1 text-[11px] text-outline hover:text-primary transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
          <span>Tip</span>
        </button>
        {show && (
          <div className="absolute bottom-full right-0 mb-2 w-64 bg-primary text-white text-[11px] rounded-xl px-3 py-2.5 shadow-xl leading-relaxed z-50 pointer-events-none">
            <div className="absolute bottom-0 right-3 translate-y-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-primary" />
            {hint}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Brand Combobox ─────────────────────────────────────────────
   Searchable dropdown backed by live brand list from orders.
   Typing filters the list; chevron opens full list; × clears.
──────────────────────────────────────────────────────────────────── */
function BrandCombobox({ value, onChange, brandList, onRefreshBrands, placeholder }) {
  const [open, setOpen]       = useState(false);
  const [query, setQuery]     = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  // dropPos: { top, left, width } for fixed-position dropdown (escapes overflow:hidden scroll parent)
  const [dropPos, setDropPos] = useState(null);
  const rootRef  = useRef(null);
  const inputRef = useRef(null);

  // Recalculate dropdown position whenever it opens or the window scrolls/resizes
  useEffect(() => {
    if (!open || !rootRef.current) { setDropPos(null); return; }
    function calcPos() {
      const r = rootRef.current?.getBoundingClientRect();
      if (r) setDropPos({ top: r.bottom + 4, left: r.left, width: r.width });
    }
    calcPos();
    window.addEventListener('scroll', calcPos, true);
    window.addEventListener('resize', calcPos);
    return () => {
      window.removeEventListener('scroll', calcPos, true);
      window.removeEventListener('resize', calcPos);
    };
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const h = e => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false); setQuery('');
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  async function handleSync(e) {
    e.stopPropagation();
    setSyncing(true); setSyncMsg(null);
    try {
      const r = await backfillBrands(false);
      setSyncMsg(`✓ ${r.ordersUpdated} updated · ${r.brandCount} brands`);
      if (onRefreshBrands) onRefreshBrands();
    } catch (err) {
      setSyncMsg('⚠ ' + (err?.response?.data?.error || err.message));
    }
    setSyncing(false);
  }

  const filtered = query
    ? brandList.filter(b => b.toLowerCase().includes(query.toLowerCase()))
    : brandList;

  function select(b) { onChange(b); setOpen(false); setQuery(''); }

  function handleInputChange(e) {
    setQuery(e.target.value);
    onChange(e.target.value);
    if (!open) setOpen(true);
  }

  const showDrop = open && dropPos;

  return (
    <div ref={rootRef} className="relative">
      {/* ── Input row ── */}
      <div className={`flex items-center border-2 rounded-lg bg-surface transition-all duration-150 ${
        open ? 'border-primary ring-2 ring-primary' : 'border-primary hover:border-primary'
      }`}>
        <input
          ref={inputRef}
          type="text"
          value={open ? query : (value || '')}
          onChange={handleInputChange}
          onFocus={() => { setOpen(true); setQuery(''); }}
          placeholder={value && !open ? value : (brandList.length > 0 ? 'Pick or type brand…' : (placeholder || 'Brand name…'))}
          className="flex-1 text-xs px-2 py-2 outline-none bg-transparent min-w-0 text-ink font-medium"
        />
        {value && !open && (
          <button type="button"
            onMouseDown={e => { e.preventDefault(); onChange(''); }}
            className="px-1.5 text-outline hover:text-rose-500 transition-colors text-sm leading-none shrink-0"
            title="Clear — applies to all brands"
          >×</button>
        )}
        <button type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={() => { setOpen(o => !o); setTimeout(() => inputRef.current?.focus(), 0); }}
          className="px-2 py-2 border-l border-primary text-primary/40 hover:text-primary transition-colors shrink-0"
        >
          <svg className={`w-3 h-3 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7"/>
          </svg>
        </button>
      </div>

      {/* ── Dropdown — fixed position so it escapes overflow:hidden scroll containers ── */}
      {showDrop && (
        <div
          style={{ position: 'fixed', top: dropPos.top, left: dropPos.left, width: dropPos.width, zIndex: 9999 }}
          className="bg-surface border border-border rounded-xl shadow-2xl overflow-hidden"
        >
          {/* "All brands" row always at top */}
          <button type="button"
            onMouseDown={e => e.preventDefault()}
            onClick={() => select('')}
            className={`w-full text-left px-3 py-2.5 text-xs border-b border-border transition-colors flex items-center gap-2.5 ${
              !value ? 'bg-surface-container-low text-secondary font-semibold' : 'text-outline hover:bg-surface-container-low'
            }`}
          >
            <span className="w-5 h-5 rounded-full bg-surface-container-high flex items-center justify-center text-[10px] shrink-0 font-bold text-secondary">∀</span>
            <span>All brands (generic rate)</span>
            {!value && <svg className="w-3.5 h-3.5 text-primary ml-auto shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/>
            </svg>}
          </button>

          {/* Brand list */}
          <div className="max-h-48 overflow-y-auto overscroll-contain">
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-center">
                <p className="text-xs font-semibold text-secondary">{query ? `"${query}"` : 'No brands yet'}</p>
                <p className="text-[10px] text-outline mt-0.5 leading-tight">
                  {query ? 'Will be saved as new brand' : 'Click "Sync" below to load from SKU Master'}
                </p>
              </div>
            ) : filtered.map(b => (
              <button key={b} type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={() => select(b)}
                className={`w-full text-left px-3 py-2.5 text-xs transition-colors flex items-center gap-2.5 ${
                  value === b
                    ? 'bg-primary-container text-primary font-bold'
                    : 'text-ink hover:bg-primary-container hover:text-primary'
                }`}
              >
                <span className={`w-5 h-5 rounded-full text-[10px] flex items-center justify-center shrink-0 font-bold ${
                  value === b ? 'bg-primary text-white' : 'bg-surface-container text-secondary'
                }`}>{b[0]?.toUpperCase()}</span>
                <span className="flex-1 truncate">{b}</span>
                {value === b && (
                  <svg className="w-3.5 h-3.5 text-primary shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/>
                  </svg>
                )}
              </button>
            ))}
          </div>

          {/* Footer: status + sync button */}
          <div className="border-t border-border bg-surface-container-low px-3 py-2 flex items-center gap-2">
            <p className="text-[10px] flex-1 min-w-0 truncate">
              {syncMsg
                ? <span className={syncMsg.startsWith('✓') ? 'text-emerald-600 font-semibold' : 'text-rose-500'}>{syncMsg}</span>
                : <span className="text-outline">{brandList.length > 0 ? `${brandList.length} brand${brandList.length !== 1 ? 's' : ''} from orders` : 'No brands — click Sync'}</span>}
            </p>
            <button type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={handleSync}
              disabled={syncing}
              className="shrink-0 text-[10px] px-2.5 py-1 rounded-lg bg-primary text-white hover:bg-primary disabled:opacity-60 transition-colors font-semibold flex items-center gap-1 whitespace-nowrap"
              title="Sync brand names from SKU Master → orders table"
            >
              <svg className={`w-2.5 h-2.5 ${syncing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
              {syncing ? 'Syncing…' : 'Sync'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Multi-Brand Select ─────────────────────────────────────────
   Like BrandCombobox but allows selecting multiple brands.
   Saves as chips; on form-save each brand becomes its own DB row.
──────────────────────────────────────────────────────────────────── */
function MultiBrandSelect({ value = [], onChange, brandList, onRefreshBrands, placeholder }) {
  const [open, setOpen]       = useState(false);
  const [query, setQuery]     = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [dropPos, setDropPos] = useState(null);
  const rootRef  = useRef(null);
  const inputRef = useRef(null);

  // Recalculate dropdown position whenever it opens or window scrolls/resizes
  useEffect(() => {
    if (!open || !rootRef.current) { setDropPos(null); return; }
    function calcPos() {
      const r = rootRef.current?.getBoundingClientRect();
      if (r) setDropPos({ top: r.bottom + 4, left: r.left, width: r.width });
    }
    calcPos();
    window.addEventListener('scroll', calcPos, true);
    window.addEventListener('resize', calcPos);
    return () => {
      window.removeEventListener('scroll', calcPos, true);
      window.removeEventListener('resize', calcPos);
    };
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const h = e => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false); setQuery('');
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  async function handleSync(e) {
    e.stopPropagation();
    setSyncing(true); setSyncMsg(null);
    try {
      const r = await backfillBrands(false);
      setSyncMsg(`✓ ${r.ordersUpdated} updated · ${r.brandCount} brands`);
      if (onRefreshBrands) onRefreshBrands();
    } catch (err) {
      setSyncMsg('⚠ ' + (err?.response?.data?.error || err.message));
    }
    setSyncing(false);
  }

  const filtered = query
    ? brandList.filter(b => b.toLowerCase().includes(query.toLowerCase()))
    : brandList;

  function toggle(b) {
    if (value.includes(b)) onChange(value.filter(x => x !== b));
    else onChange([...value, b]);
  }

  function removeChip(b, e) {
    e.preventDefault(); e.stopPropagation();
    onChange(value.filter(x => x !== b));
  }

  const showDrop = open && dropPos;

  return (
    <div ref={rootRef} className="relative">
      {/* ── Tag chips + search input ── */}
      <div
        className={`flex flex-wrap items-center gap-1 border-2 rounded-lg bg-surface px-2 py-1.5 min-h-[34px] cursor-text transition-all duration-150 ${
          open ? 'border-primary ring-2 ring-primary' : 'border-primary hover:border-primary'
        }`}
        onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }}
      >
        {value.map(b => (
          // Brand chip — burgundy tint via primary-container. The max-w
          // was 100px which clipped brand names like "Ethnic Junction" at
          // ~10 chars; 200px is enough for any brand label the marketplace
          // produces while still keeping the input usable on narrow rows.
          <span key={b} className="flex items-center gap-1 px-2 py-0.5 bg-primary-container text-primary rounded-md text-[11px] font-semibold whitespace-nowrap max-w-[200px] border border-primary/15">
            <span className="truncate">{b}</span>
            <button type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={e => removeChip(b, e)}
              aria-label={`Remove ${b}`}
              className="text-primary/50 hover:text-primary leading-none shrink-0 ml-0.5 transition-colors"
            >×</button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={value.length === 0 ? (placeholder || 'All brands (generic rate)') : '+ add brand…'}
          className="flex-1 text-xs outline-none bg-transparent min-w-[60px] text-ink py-0.5"
        />
        <button type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={e => { e.stopPropagation(); setOpen(o => !o); setTimeout(() => inputRef.current?.focus(), 0); }}
          className="text-primary/40 hover:text-primary transition-colors shrink-0 pl-1"
        >
          <svg className={`w-3 h-3 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7"/>
          </svg>
        </button>
      </div>

      {/* ── Dropdown — fixed position to escape overflow:hidden scroll container ── */}
      {showDrop && (
        <div
          style={{ position: 'fixed', top: dropPos.top, left: dropPos.left, width: dropPos.width, zIndex: 9999 }}
          className="bg-surface border border-border rounded-xl shadow-2xl overflow-hidden"
        >
          {/* "All brands" (clear) row */}
          <button type="button"
            onMouseDown={e => e.preventDefault()}
            onClick={() => onChange([])}
            className={`w-full text-left px-3 py-2.5 text-xs border-b border-border transition-colors flex items-center gap-2.5 ${
              value.length === 0 ? 'bg-surface-container-low text-secondary font-semibold' : 'text-outline hover:bg-surface-container-low'
            }`}
          >
            <span className="w-5 h-5 rounded-full bg-surface-container-high flex items-center justify-center text-[10px] shrink-0 font-bold text-secondary">∀</span>
            <span className="flex-1">All brands (generic rate)</span>
            {value.length === 0 && <svg className="w-3.5 h-3.5 text-primary ml-auto shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/>
            </svg>}
          </button>

          {/* Brand list with multi-checkmarks */}
          <div className="max-h-48 overflow-y-auto overscroll-contain">
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-center">
                <p className="text-xs font-semibold text-secondary">{query ? `"${query}"` : 'No brands yet'}</p>
                <p className="text-[10px] text-outline mt-0.5 leading-tight">
                  {query ? 'Not in orders yet — will still save' : 'Click "Sync" below to load from SKU Master'}
                </p>
              </div>
            ) : filtered.map(b => {
              const sel = value.includes(b);
              return (
                <button key={b} type="button"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => toggle(b)}
                  className={`w-full text-left px-3 py-2.5 text-xs transition-colors flex items-center gap-2.5 ${
                    sel ? 'bg-primary-container text-primary font-bold' : 'text-ink hover:bg-primary-container hover:text-primary'
                  }`}
                >
                  <span className={`w-5 h-5 rounded-full text-[10px] flex items-center justify-center shrink-0 font-bold ${
                    sel ? 'bg-primary text-white' : 'bg-surface-container text-secondary'
                  }`}>{b[0]?.toUpperCase()}</span>
                  <span className="flex-1 truncate">{b}</span>
                  {/* checkbox-style indicator */}
                  <span className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-all ${
                    sel ? 'bg-primary border-primary' : 'border-border'
                  }`}>
                    {sel && <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/>
                    </svg>}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Footer: count + sync */}
          <div className="border-t border-border bg-surface-container-low px-3 py-2 flex items-center gap-2">
            <p className="text-[10px] flex-1 min-w-0 truncate">
              {syncMsg
                ? <span className={syncMsg.startsWith('✓') ? 'text-emerald-600 font-semibold' : 'text-rose-500'}>{syncMsg}</span>
                : value.length > 0
                  ? <span className="text-primary font-semibold">{value.length} selected → saves {value.length} row{value.length !== 1 ? 's' : ''}</span>
                  : <span className="text-outline">{brandList.length > 0 ? `${brandList.length} brands from orders` : 'No brands — click Sync'}</span>}
            </p>
            <button type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={handleSync}
              disabled={syncing}
              className="shrink-0 text-[10px] px-2.5 py-1 rounded-lg bg-primary text-white hover:bg-primary disabled:opacity-60 transition-colors font-semibold flex items-center gap-1 whitespace-nowrap"
              title="Sync brand names from SKU Master → orders table"
            >
              <svg className={`w-2.5 h-2.5 ${syncing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
              {syncing ? 'Syncing…' : 'Sync'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Rate Period Drawer ──────────────────────────────────────────
   Modes:
   1. Add new period  — initialCategory='', editPeriodIds=null
   2. New rate for category — initialCategory set, editPeriodIds=null
   3. Edit existing period  — initialCategory set, editPeriodIds=[ids], initialFrom/To set
   4. Copy period     — isCopy=true, copyFromCategory set, category blank, slabs pre-filled
──────────────────────────────────────────────────────────────────── */
function RatePeriodDrawer({
  type, config, marketplace, sellerAccount = 'default',
  initialCategory,
  currentRows,
  editPeriodIds,      // array of row IDs to delete before re-inserting (edit mode)
  initialFrom,        // pre-fill effectiveFrom in edit mode
  initialTo,          // pre-fill endDate in edit mode
  isCopy,             // copy mode — slabs pre-filled, category unlocked, fresh dates
  copyFromCategory,   // source category label shown in subtitle
  onClose, onSaved,
}) {
  const isEditPeriod  = !!editPeriodIds?.length;   // editing an existing period
  const isEditing     = !!initialCategory;          // category is locked (not copy/add)

  const [category, setCategory]         = useState(initialCategory || '');
  const [extraCategories, setExtraCats] = useState([]);  // multi-apply
  const [effectiveFrom, setFrom]        = useState(initialFrom || getTomorrow());
  const [endDate, setEndDate]           = useState(initialTo   || '');
  const [autoClose, setAutoClose]       = useState(!isEditPeriod);
  const [slabs, setSlabs]               = useState(
    currentRows.length > 0
      ? currentRows.map(r => {
          const slab = {};
          config.formFields.forEach(f => {
            if (f.type === 'multi_brand') {
              // Existing rows have a single string; wrap it in an array
              slab[f.key] = r[f.key] ? [r[f.key]] : [];
            } else {
              slab[f.key] = r[f.key] ?? '';
            }
          });
          return slab;
        })
      : [config.defaultSlab()]
  );
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState('');   // "Saving category 2 / 5…"
  const [err, setErr]       = useState(null);

  // ── Brand list for commission / franchise_fee brand dropdowns ────
  // 'd.brands' is the key returned by GET /api/filters (plural, not d.brand)
  const [brandList, setBrandList] = useState([]);
  function refreshBrandList() {
    fetchFilters()
      .then(d => setBrandList((d.brands || []).filter(Boolean).sort()))
      .catch(() => {});
  }
  useEffect(() => {
    if (type === 'commission' || type === 'franchise_fee') refreshBrandList();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  const showAutoClose = !endDate && !isEditPeriod;
  const mpMeta = MARKETPLACES.find(m => m.id === marketplace) || MARKETPLACES[0];

  // ── AI Screenshot Parser ──────────────────────────────────────
  const [aiOpen, setAiOpen]       = useState(false);
  const fileInputRef     = useRef(null);
  const [aiImage, setAiImage]       = useState(null);   // data-URL preview
  const [aiImageB64, setAiB64]      = useState(null);   // base64 only (no prefix)
  const [aiMime, setAiMime]         = useState('image/png');
  const [aiParsing, setAiParsing]   = useState(false);
  const [aiMsg, setAiMsg]           = useState(null);   // { ok, text }

  function loadImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    setAiMime(file.type);
    const reader = new FileReader();
    reader.onload = e => {
      const dataUrl = e.target.result;
      setAiImage(dataUrl);
      // Strip the "data:image/...;base64," prefix
      setAiB64(dataUrl.split(',')[1]);
      setAiMsg(null);
      setAiOpen(true);
    };
    reader.readAsDataURL(file);
  }

  function handleImagePaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        loadImageFile(item.getAsFile());
        return;
      }
    }
  }

  function handleFileDrop(e) {
    e.preventDefault();
    loadImageFile(e.dataTransfer.files[0]);
  }

  async function handleParseImage() {
    if (!aiImageB64) return;
    setAiParsing(true); setAiMsg(null);
    try {
      const { slabs: parsed, count, modelUsed } = await parseRateCardImage({
        imageBase64: aiImageB64,
        mimeType:    aiMime,
        type,
      });

      // Guard against empty/undefined response from backend
      if (!Array.isArray(parsed) || parsed.length === 0) {
        setAiMsg({ ok: false, text: 'No slabs detected in the screenshot. Try a clearer image or enter slabs manually.' });
        setAiParsing(false);
        return;
      }

      let existingBrand = null;
      if (slabs.length > 0 && slabs[0].brand_name && slabs[0].brand_name.length > 0) {
        existingBrand = slabs[0].brand_name;
      }

      // Map parsed fields to form fields (strip unknown keys)
      const mapped = parsed.map(row => {
        const slab = config.defaultSlab();
        config.formFields.forEach(f => {
          if (f.key in row) slab[f.key] = row[f.key];
        });
        if (existingBrand && slab.brand_name !== undefined) {
          slab.brand_name = existingBrand;
        }
        return slab;
      });
      setSlabs(mapped);
      const modelLabel = modelUsed ? ` · via ${modelUsed}` : '';
      setAiMsg({ ok: true, text: `✓ ${count} slabs extracted${modelLabel} — check & adjust before saving` });
    } catch (e) {
      setAiMsg({ ok: false, text: e.response?.data?.error || e.message });
    }
    setAiParsing(false);
  }
  // ─────────────────────────────────────────────────────────────

  function addSlab()             { setSlabs(s => [...s, config.defaultSlab()]); }
  function removeSlab(i)         { setSlabs(s => s.filter((_, j) => j !== i)); }
  function setSlabField(i, k, v) { setSlabs(s => s.map((row, j) => j === i ? { ...row, [k]: v } : row)); }

  async function handleSave() {
    setErr(null);
    if (!category.trim())        { setErr('Please select or enter a category'); return; }
    if (!effectiveFrom)          { setErr('Effective From date is required'); return; }
    if (endDate && endDate <= effectiveFrom) { setErr('End Date must be after Effective From date'); return; }
    if (slabs.length === 0)      { setErr('Add at least one slab/row'); return; }
    setSaving(true); setSaveProgress('');
    try {
      // Expand multi-brand slabs: each selected brand becomes its own DB row
      const expandedSlabs = slabs.flatMap(s => {
        const brands = Array.isArray(s.brand_name) ? s.brand_name : [];
        if (brands.length === 0) return [{ ...s, brand_name: null }];
        return brands.map(b => ({ ...s, brand_name: b }));
      });

      if (isEditPeriod) {
        // The server deletes and re-inserts in one transaction, so a validation
        // or network error never leaves an edited rate period half deleted.
        setSaveProgress('Saving revised period…');
        await saveRateCardPeriod(type, {
          category: category.trim(), marketplace, seller_account: sellerAccount,
          // Backend reads `start_date` / `end_date`. Renaming on the client
          // keeps the API contract consistent and stops every "edit" from
          // recording NULL dates (which is what previously wiped unrelated
          // historical rows that happened to share start_date IS NULL).
          start_date: effectiveFrom, end_date: endDate || null,
          replaceIds: editPeriodIds,
          rows: expandedSlabs,
        });
      } else {
        // Build full category list — primary + any extras selected for multi-apply
        const allCats = [...new Set([category.trim(), ...extraCategories])].filter(Boolean);
        for (let i = 0; i < allCats.length; i++) {
          setSaveProgress(allCats.length > 1 ? `Saving ${i + 1} / ${allCats.length}: ${allCats[i]}…` : '');
          await saveRateCardPeriod(type, {
            category: allCats[i], marketplace, seller_account: sellerAccount,
            start_date: effectiveFrom, end_date: endDate || null,
            rows: expandedSlabs,
          });
        }
      }
      onSaved();
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    }
    setSaving(false); setSaveProgress('');
  }

  const colorMap = { indigo: 'bg-primary', violet: 'bg-violet-600', blue: 'bg-blue-600', cyan: 'bg-cyan-600', rose: 'bg-rose-600', amber: 'bg-amber-600' };
  const btnColor = colorMap[config.color] || 'bg-primary';

  const drawerTitle = isEditPeriod
    ? `Edit Period — ${initialCategory}`
    : isCopy
      ? `Copy Rate Period`
      : isEditing
        ? `New Rate Period — ${initialCategory}`
        : 'Add New Rate Period';

  const drawerSubtitle = isEditPeriod
    ? `Editing: ${fmtDate(initialFrom)} → ${fmtDate(initialTo || null)} · Changes saved to PostgreSQL`
    : isCopy
      ? `Copied from: ${copyFromCategory} · ${config.title} · ${mpMeta.emoji} ${mpMeta.label}`
      : `${config.title} · ${mpMeta.emoji} ${mpMeta.label}`;

  return (
    <>
      <div className="fixed inset-0 modal-backdrop z-40" onClick={onClose} />

      {/* Modal dialog — centered, scrollable */}
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        onPaste={handleImagePaste}
      >
        <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-[800px] max-h-[92vh] flex flex-col overflow-hidden border border-border/80 ring-1 ring-border/5">

          {/* ── Gradient Header ── */}
          <div className={`px-5 sm:px-6 py-4 border-b border-border shrink-0 ${isEditPeriod ? 'bg-gradient-to-r from-amber-50 to-orange-50' : isCopy ? 'bg-gradient-to-r from-teal-50 to-emerald-50' : 'bg-gradient-to-r from-primary-container via-white to-blue-50'}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg shadow-sm ${
                  isEditPeriod ? 'bg-amber-100' : isCopy ? 'bg-teal-100' : 'bg-primary-container'
                }`}>
                  {isEditPeriod ? '✏️' : isCopy ? '📋' : '💰'}
                </div>
                <div>
                  <h2 className="font-bold text-ink text-headline-md">{drawerTitle}</h2>
                  <p className="text-xs text-secondary mt-0.5">{drawerSubtitle}</p>
                </div>
              </div>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-surface-container hover:bg-surface-container-high flex items-center justify-center text-secondary transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>
            {isEditPeriod && (
              <div className="mt-3 inline-flex items-center gap-1.5 text-[11px] bg-amber-100 text-amber-800 px-2.5 py-1 rounded-lg font-semibold border border-amber-200">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.07 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                Edit mode — old period will be deleted and replaced in DB
              </div>
            )}
            {isCopy && (
              <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] bg-teal-100 text-teal-800 px-2.5 py-1 rounded-full font-semibold">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                Copy mode — slabs pre-filled, pick new category &amp; dates
              </div>
            )}
          </div>

          {/* ── Scrollable body ── */}
          <div className="flex-1 overflow-y-auto px-5 sm:px-6 py-5 space-y-4">

          {/* Step progress */}
          <div className="flex items-center gap-1 mb-1">
            {['Category', 'Dates', 'Slabs'].map((label, i) => (
              <div key={label} className="flex items-center flex-1 min-w-0">
                <div className={`flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide truncate ${
                  (i === 0 && category) || (i === 1 && effectiveFrom) || (i === 2 && slabs.length > 0)
                    ? 'text-primary' : 'text-outline'
                }`}>
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] shrink-0 ${
                    (i === 0 && category) || (i === 1 && effectiveFrom) || (i === 2 && slabs.length > 0)
                      ? 'bg-primary text-white' : 'bg-surface-container-high text-secondary'
                  }`}>{i + 1}</span>
                  <span className="hidden sm:inline">{label}</span>
                </div>
                {i < 2 && <div className="flex-1 h-px bg-surface-container-high mx-2" />}
              </div>
            ))}
          </div>

          {/* Section 1: Category */}
          <ModalSection step="1" title="Category">
            <CategorySelector
              marketplace={marketplace}
              sellerAccount={sellerAccount}
              value={category}
              onChange={setCategory}
              disabled={isEditing}
            />
            {!isEditing && (
              <>
                <p className="text-[11px] text-outline mt-2 leading-relaxed">
                  Loaded from your actual {mpMeta.label} orders — rates always match reconciliation reports.
                </p>
                <AdditionalCategoriesSelector
                  marketplace={marketplace}
                  sellerAccount={sellerAccount}
                  primaryCategory={category}
                  value={extraCategories}
                  onChange={setExtraCats}
                />
                {extraCategories.length > 0 && (
                  <div className="mt-2 text-[11px] text-primary font-semibold bg-primary-container border border-primary rounded-lg px-3 py-2">
                    Will save identical slabs for {1 + extraCategories.length} categories
                  </div>
                )}
              </>
            )}
          </ModalSection>

          {/* Section 2: Dates */}
          <ModalSection step="2" title="Rate Period Dates">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-secondary mb-1.5">
                  Effective From <span className="text-rose-500">*</span>
                </label>
                <input
                  type="date"
                  value={effectiveFrom}
                  onChange={e => setFrom(e.target.value)}
                  className="w-full text-sm border border-border rounded-xl px-3 py-2.5 bg-surface focus:ring-2 focus:ring-primary/50 focus:border-primary outline-none shadow-sm"
                />
                <p className="text-[10px] text-outline mt-1">When this rate starts</p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-secondary mb-1.5">
                  End Date <span className="text-outline font-normal">(optional)</span>
                </label>
                <input
                  type="date"
                  value={endDate}
                  onChange={e => setEndDate(e.target.value)}
                  min={effectiveFrom || undefined}
                  className="w-full text-sm border border-border rounded-xl px-3 py-2.5 bg-surface focus:ring-2 focus:ring-primary/50 focus:border-primary outline-none shadow-sm"
                />
                <p className="text-[10px] text-outline mt-1">Leave blank if still active today</p>
              </div>
            </div>

            {isEditPeriod ? (
              <div className="mt-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-800 flex items-start gap-2">
                <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                <span>
                  <strong>Editing period</strong> — old rows ({editPeriodIds.length}) will be replaced in PostgreSQL.
                </span>
              </div>
            ) : endDate ? (
              <div className="mt-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-700">
                <strong>Historical entry</strong> — {fmtDate(effectiveFrom)} → {fmtDate(endDate)}. Auto-close is off.
              </div>
            ) : (
              <label className="mt-3 flex items-start gap-3 p-3 bg-surface rounded-xl border border-border cursor-pointer hover:border-primary transition-colors">
                <input
                  type="checkbox"
                  checked={autoClose}
                  onChange={e => setAutoClose(e.target.checked)}
                  className="mt-0.5 w-4 h-4 text-primary rounded border-border"
                />
                <span>
                  <span className="text-sm font-semibold text-ink block">Auto-close current active rate</span>
                  <span className="text-[11px] text-secondary block mt-0.5">
                    Ends existing rate on <strong>{effectiveFrom ? fmtDate(dateMinus1(effectiveFrom)) : '—'}</strong> (day before new rate). Recommended.
                  </span>
                </span>
              </label>
            )}
          </ModalSection>

          {/* ── AI Screenshot Parser (collapsible) ───────────────── */}
          <section className="rounded-xl border border-purple-200/60 bg-purple-50/30 overflow-hidden">
            <button
              type="button"
              onClick={() => setAiOpen(o => !o)}
              className="w-full px-4 py-3 flex items-center justify-between gap-2 hover:bg-purple-50/60 transition-colors text-left"
            >
              <div className="flex items-center gap-2">
                <span className="text-base">✨</span>
                <span className="text-sm font-bold text-ink">Auto-fill from Screenshot</span>
                <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-bold uppercase">AI · Gemini Vision</span>
                {aiImage && <span className="text-[10px] text-emerald-600 font-semibold">· Image loaded</span>}
              </div>
              <svg className={`w-4 h-4 text-outline transition-transform ${aiOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {aiOpen && (
              <div className="px-4 pb-4 pt-3 border-t border-purple-100" onDrop={handleFileDrop} onDragOver={e => e.preventDefault()}>
                {aiImage ? (
                  <div className="rounded-xl border border-purple-200 bg-surface overflow-hidden">
                    <div className="px-4 pt-3 pb-2 flex items-start gap-3">
                      <img
                        src={aiImage}
                        alt="Rate card screenshot"
                        className="max-h-28 max-w-[160px] rounded-lg border border-purple-200 object-contain shrink-0 cursor-pointer"
                        onClick={() => { setAiImage(null); setAiB64(null); setAiMsg(null); }}
                        title="Click to remove image"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-secondary font-semibold mb-1">Screenshot loaded</p>
                        <p className="text-[11px] text-outline mb-3">
                          Gemini reads every row from your screenshot and maps the slabs automatically.
                        </p>
                        <div className="flex gap-2 flex-wrap">
                          <button
                            type="button"
                            onClick={handleParseImage}
                            disabled={aiParsing}
                            className="flex items-center gap-1.5 px-4 py-2 bg-purple-600 text-white rounded-xl text-xs font-bold hover:bg-purple-700 disabled:opacity-60 shadow-sm transition-all"
                          >
                            {aiParsing ? 'Parsing…' : '✨ Extract All Slabs'}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setAiImage(null); setAiB64(null); setAiMsg(null); }}
                            className="px-3 py-2 text-xs border border-border text-secondary rounded-xl hover:bg-surface-container-low"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </div>
                    {aiMsg && (
                      <div className={`mx-3 mb-3 px-3 py-2 rounded-lg text-xs font-medium ${aiMsg.ok ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}`}>
                        {aiMsg.text}
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="border-2 border-dashed border-purple-200 rounded-xl px-5 py-4 flex flex-col items-center text-center cursor-pointer hover:border-purple-400 hover:bg-white/60 transition-colors"
                  >
                    <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center mb-2">
                      <svg className="w-5 h-5 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <p className="text-sm font-semibold text-secondary">
                      Paste <kbd className="bg-surface-container px-1.5 py-0.5 rounded text-[10px] font-mono">Ctrl+V</kbd> or click to upload
                    </p>
                    <p className="text-[11px] text-outline mt-1">Screenshot your marketplace rate card table</p>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={e => loadImageFile(e.target.files[0])}
                />
              </div>
            )}
          </section>

          {/* Section 3: Rate slabs */}
          <ModalSection step="3" title={`Rate Slabs · ${slabs.length} row${slabs.length !== 1 ? 's' : ''}`}>

            {slabs.length === 0 && (
              <div className="text-center py-8 border-2 border-dashed border-border rounded-2xl">
                <div className="text-3xl mb-2">📋</div>
                <p className="text-secondary font-medium text-sm">No slabs yet</p>
                <p className="text-outline text-xs mt-1">Click "+ Add Slab" above to start</p>
              </div>
            )}

            <div className="space-y-3">
              {slabs.map((slab, i) => (
                <div key={i} className="rounded-2xl border-2 border-border bg-surface-container-low/60 overflow-hidden">
                  {/* Slab header */}
                  <div className="flex items-center justify-between px-4 py-2 bg-surface border-b border-border">
                    <span className="text-[11px] font-bold text-secondary uppercase tracking-wide">Slab {i + 1}</span>
                    <button
                      onClick={() => removeSlab(i)}
                      className="flex items-center gap-1 text-[11px] text-rose-400 hover:text-rose-600 transition-colors font-medium"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      Remove
                    </button>
                  </div>
                  {/* Slab fields */}
                  <div className="px-4 py-3 flex items-end gap-2 flex-wrap">
                    {config.formFields.map(field => {
                      // ── ₹/% toggle ──
                      if (field.type === 'rate_type') {
                        const cur = slab[field.key] || 'pct';
                        return (
                          <div key={field.key} className="flex flex-col" style={{ flex: field.flex || '0 0 60px' }}>
                            <label className="text-[10px] text-outline font-semibold mb-1.5 uppercase tracking-wide">{field.label}</label>
                            <div className="flex rounded-lg overflow-hidden border-2 border-border bg-surface" style={{ height: 34 }}>
                              {[['pct', '%'], ['flat', '₹']].map(([val, lbl]) => (
                                <button key={val} type="button"
                                  onClick={() => setSlabField(i, field.key, val)}
                                  className={`flex-1 text-[12px] font-bold transition-all ${
                                    cur === val
                                      ? val === 'pct'
                                        ? 'bg-primary text-white'
                                        : 'bg-emerald-500 text-white'
                                      : 'text-outline hover:bg-surface-container-low'
                                  }`}
                                >{lbl}</button>
                              ))}
                            </div>
                          </div>
                        );
                      }

                      // ── Regular field ──
                      const isPct  = field.hint?.includes('Decimal') || field.hint?.includes('decimal') || field.hint?.includes('%');
                      const isFlat = ['rate', 'local_fee', 'zonal_fee', 'national_fee'].includes(field.key) && !isPct;
                      const badge  = (field.key === 'price_min' || field.key === 'price_max') ? '₹'
                        : isPct ? '%' : isFlat ? '₹' : null;
                      return (
                        <div key={field.key} className="flex flex-col min-w-0" style={{ flex: field.flex || '1 1 80px' }}>
                          <label className="text-[10px] font-semibold text-secondary mb-1.5 uppercase tracking-wide flex items-center gap-1">
                            {field.label}
                            {badge && (
                              <span className={`px-1 py-0.5 rounded text-[10px] font-bold ${badge === '%' ? 'bg-primary-container text-primary' : 'bg-emerald-100 text-emerald-700'}`}>
                                {badge}
                              </span>
                            )}
                          </label>
                          {field.type === 'multi_brand' ? (
                            <MultiBrandSelect
                              value={Array.isArray(slab[field.key]) ? slab[field.key] : (slab[field.key] ? [slab[field.key]] : [])}
                              onChange={v => setSlabField(i, field.key, v)}
                              brandList={brandList}
                              onRefreshBrands={refreshBrandList}
                              placeholder={field.placeholder}
                            />
                          ) : field.key === 'brand_name' ? (
                            <BrandCombobox
                              value={slab[field.key] ?? ''}
                              onChange={v => setSlabField(i, field.key, v)}
                              brandList={brandList}
                              onRefreshBrands={refreshBrandList}
                              placeholder={field.placeholder}
                            />
                          ) : field.type === 'select' ? (
                            <select
                              value={slab[field.key] ?? ''}
                              onChange={e => setSlabField(i, field.key, e.target.value)}
                              className="w-full text-xs border-2 border-border rounded-lg px-2 py-2 bg-surface focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                            >
                              {field.options.map(o => <option key={o}>{o}</option>)}
                            </select>
                          ) : (
                            <input
                              type={field.type}
                              step={field.step}
                              value={slab[field.key] ?? ''}
                              onChange={e => setSlabField(i, field.key, e.target.value)}
                              placeholder={field.placeholder}
                              title={field.hint || field.help}
                              className="w-full text-xs border-2 border-border rounded-lg px-2 py-2 bg-surface focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                            />
                          )}
                          {field.help && (
                            <p className="text-[10px] text-outline mt-1 leading-tight">{field.help}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* ── Add slab button — at the bottom ── */}
            <button
              onClick={addSlab}
              className="w-full mt-2 py-3 border-2 border-dashed border-primary text-primary hover:border-primary hover:bg-primary-container/60 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-colors group"
            >
              <svg className="w-4 h-4 group-hover:scale-110 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              + Add Another Slab
            </button>

            {/* formHint — collapsed into a small ℹ tooltip, not a yellow bar */}
            {config.formHint && <FormHintTip hint={config.formHint.replace('💡 ', '')} />}
          </ModalSection>

          {/* Error */}
          {err && (
            <div className="bg-rose-50 border-2 border-rose-200 rounded-xl px-4 py-3 text-sm text-rose-700 flex items-start gap-2">
              <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {err}
            </div>
          )}
          </div>{/* end scrollable body */}

          {/* Footer */}
          <div className="px-5 sm:px-6 py-4 border-t border-border bg-surface shrink-0">
            <div className="flex items-center justify-between gap-3 mb-3 text-[11px] text-secondary">
              <span>
                {category ? <strong className="text-ink">{category}</strong> : 'No category'}
                {effectiveFrom && <> · from {fmtDate(effectiveFrom)}</>}
                {slabs.length > 0 && <> · {slabs.length} slab{slabs.length !== 1 ? 's' : ''}</>}
              </span>
              <span className="text-outline">{mpMeta.emoji} {mpMeta.label}</span>
            </div>
            <div className="flex gap-3">
            <button onClick={onClose}
              className="flex-1 py-2.5 border border-border text-secondary rounded-xl text-sm hover:bg-surface-container-low font-semibold transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !category || !effectiveFrom || slabs.length === 0}
              className={`flex-[1.4] py-2.5 text-white rounded-xl text-sm font-bold disabled:opacity-50 ${btnColor} hover:opacity-90 shadow-md transition-all`}
            >
              {saving ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  {saveProgress || 'Saving to PostgreSQL…'}
                </span>
              ) : isEditPeriod
                ? '✓ Save Edited Period'
                : isCopy
                  ? '✓ Save Copied Period'
                  : extraCategories.length > 0
                    ? `✓ Save for ${1 + extraCategories.length} Categories`
                    : '✓ Save Rate Period'}
            </button>
            </div>
          </div>

        </div>
      </div>
    </>
  );
}

  /* ─── Fee type view (one tab) ─────────────────────────────────── */
  function FeeTypeView({ type, marketplace, sellerAccount = 'default', onCoverageDirty, coverage }) {
    const config = FEE_CONFIGS[type];
    const [rows, setRows]         = useState([]);
    const [loading, setLoading]   = useState(true);
    const [err, setErr]           = useState(null);
    const [viewMode, setViewMode] = useState('active');
    const [drawer, setDrawer]     = useState(null);
    // Toast-style banner for ephemeral success / error feedback, replacing
    // window.alert / window.confirm.
    const [banner, setBanner]     = useState(null); // { tone: 'success' | 'error', text }
    // Confirm dialog state for destructive flows.
    const [confirm, setConfirm]   = useState(null); // { title, description, action, variant }
    const [confirmBusy, setConfirmBusy] = useState(false);

    const load = useCallback(async () => {
      setLoading(true); setErr(null);
      try {
        const d = await fetchRateCardConfig(type, marketplace, sellerAccount);
        setRows(d.rows || []);
      } catch (e) { setErr(e.message); }
      setLoading(false);
    }, [type, marketplace, sellerAccount]);

  useEffect(() => { load(); }, [load]);

  // Group by category
  const byCategory = {};
  rows.forEach(r => {
    const cat = r.category || '(no category)';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(r);
  });

  const allCategories = Object.keys(byCategory).sort();
  const visibleCategories = viewMode === 'active'
    ? allCategories.filter(cat => byCategory[cat].some(r => rowStatus(r) === 'active'))
    : allCategories;

  async function handleDeletePeriod(ids) {
    if (!ids?.length) return;
    const mpLabel = MARKETPLACES.find(m => m.id === marketplace)?.label || marketplace;
    setConfirm({
      title: `Delete ${ids.length} rate row${ids.length > 1 ? 's' : ''}?`,
      description: `Marketplace: ${mpLabel} · Account: ${sellerAccount} · Fee: ${config.title}\n\nThis permanently removes them from PostgreSQL.`,
      variant: 'danger',
      confirmLabel: 'Delete',
      action: async () => {
        setConfirmBusy(true);
        try {
          // Sequential delete with per-row failure capture so the user sees
          // exactly which rows could not be removed (instead of half-deleting
          // silently and reporting nothing).
          const failed = [];
          for (const id of ids) {
            try { await deleteRateCardRow(type, id, marketplace, sellerAccount); }
            catch (err) { failed.push({ id, message: err.response?.data?.error || err.message }); }
          }
          await load();
          setConfirm(null);
          if (failed.length === 0) {
            setBanner({ tone: 'success', text: `Deleted ${ids.length} row${ids.length > 1 ? 's' : ''}.` });
          } else {
            setBanner({
              tone: 'error',
              text: `Deleted ${ids.length - failed.length} of ${ids.length} — ${failed.length} failed: ${failed[0].message}`,
            });
          }
        } finally {
          setConfirmBusy(false);
        }
      },
    });
  }

  function handleEditPeriod(category, pRows) {
    setDrawer({
      category,
      rows: pRows,
      editIds:     pRows.map(r => r.id),
      initialFrom: toDateStr(pRows[0]?.start_date),
      initialTo:   toDateStr(pRows[0]?.end_date),
      isCopy:      false,
      copyFromCat: null,
    });
  }

  function handleCopyPeriod(sourceCategory, pRows) {
    setDrawer({
      category:    '',        // blank — user picks target category
      rows:        pRows,     // slabs pre-filled from source period
      editIds:     null,      // NOT edit mode
      initialFrom: null,      // fresh dates
      initialTo:   null,
      isCopy:      true,
      copyFromCat: sourceCategory,
    });
  }

  const colorBgMap = { indigo: 'bg-primary', violet: 'bg-violet-600', blue: 'bg-blue-600', cyan: 'bg-cyan-600', rose: 'bg-rose-600', amber: 'bg-amber-600' };
  const mpMeta = MARKETPLACES.find(m => m.id === marketplace) || MARKETPLACES[0];

  // Auto-dismiss the toast banner after a few seconds. We track via ref so
  // the timeout id is cancelled if a new banner arrives mid-display.
  const bannerTimerRef = useRef(null);
  useEffect(() => {
    if (!banner) return undefined;
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = setTimeout(() => setBanner(null), 4500);
    return () => { if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current); };
  }, [banner]);

  if (loading) return (
    <div className="animate-pulse space-y-4">
      {[1, 2, 3].map(i => <div key={i} className="h-32 bg-surface-container rounded-xl" />)}
    </div>
  );
  if (err) return (
    <div className="bg-rose-50 border border-rose-200 rounded-xl p-5 text-rose-700 text-sm">Failed to load: {err}</div>
  );

  const bannerPalette = banner?.tone === 'success'
    ? { ring: 'border-emerald-200', bg: 'bg-emerald-50', text: 'text-emerald-800', icon: 'text-emerald-600' }
    : { ring: 'border-rose-200',   bg: 'bg-rose-50',   text: 'text-rose-800',   icon: 'text-rose-600' };

  return (
    <div className="space-y-4">
      {banner && (
        <div
          role="status"
          aria-live="polite"
          className={`flex items-start gap-3 rounded-xl border ${bannerPalette.ring} ${bannerPalette.bg} px-4 py-3 ${bannerPalette.text} shadow-sm animate-[modal-fade-in_200ms_ease-out]`}
        >
          <svg className={`w-4 h-4 mt-0.5 shrink-0 ${bannerPalette.icon}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            {banner.tone === 'success'
              ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              : <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75M12 17.25h.008v.008H12v-.008zM10.29 3.86l-8.18 14.18A2 2 0 003.84 21h16.32a2 2 0 001.73-2.96L13.71 3.86a2 2 0 00-3.42 0z" />}
          </svg>
          <p className="text-sm flex-1 whitespace-pre-line">{banner.text}</p>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="text-current opacity-60 hover:opacity-100 transition-opacity"
            aria-label="Dismiss notification"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M6 18L18 6" />
            </svg>
          </button>
        </div>
      )}
      <FeeTypeCoveragePanel
        feeType={type}
        coverage={coverage}
        marketplace={marketplace}
        sellerAccount={sellerAccount}
        onConfigureCategory={(cat) => setDrawer({
          category: cat,
          rows: [],
          editIds: null,
          isCopy: false,
          copyFromCat: null,
        })}
      />

      {/* Controls bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-secondary flex-1">{config.description}</p>
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex bg-surface-container rounded-xl p-0.5">
            {[['active', '● Active Now'], ['all', '⊙ All History']].map(([v, l]) => (
              <button key={v} onClick={() => setViewMode(v)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  viewMode === v ? 'bg-surface text-ink shadow-sm' : 'text-secondary hover:text-ink'
                }`}>{l}</button>
            ))}
          </div>
          <button
            onClick={() => setDrawer({ category: '', rows: [], editIds: null, isCopy: false, copyFromCat: null })}
            className={`flex items-center gap-1.5 text-xs px-4 py-2 rounded-xl text-white font-semibold ${colorBgMap[config.color] || 'bg-primary'} hover:opacity-90 shadow-sm transition-all`}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Rate Period
          </button>
        </div>
      </div>

      <p className="text-xs text-outline">
        {viewMode === 'active'
          ? `${visibleCategories.length} categor${visibleCategories.length !== 1 ? 'ies' : 'y'} with active rates on ${mpMeta.label}`
          : `${allCategories.length} total categor${allCategories.length !== 1 ? 'ies' : 'y'} · ${rows.length} rows in database`}
        {viewMode === 'active' && allCategories.length > visibleCategories.length &&
          ` — ${allCategories.length - visibleCategories.length} have no active rate (switch to All History to see them)`}
      </p>

      {/* Category cards */}
      {visibleCategories.length === 0 ? (
        <div className="text-center py-16 border-2 border-dashed border-border rounded-2xl">
          <div className="text-5xl mb-3">{config.icon}</div>
          <p className="text-secondary font-bold text-base">No rates configured yet for {mpMeta.label}</p>
          <p className="text-outline text-sm mt-1 mb-5">Add one rate period per product category to get started</p>
          <button
            onClick={() => setDrawer({ category: '', rows: [], editIds: null, isCopy: false, copyFromCat: null })}
            className="text-sm px-5 py-2.5 bg-primary text-white rounded-xl hover:bg-primary font-semibold shadow-sm"
          >
            + Add First Rate Period
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleCategories.map(cat => (
            <CategoryCard
              key={cat}
              category={cat}
              allRows={byCategory[cat]}
              config={config}
              onEdit={(category, activeRows) => setDrawer({ category, rows: activeRows, editIds: null, isCopy: false, copyFromCat: null })}
              onEditPeriod={handleEditPeriod}
              onCopyPeriod={handleCopyPeriod}
              onDelete={handleDeletePeriod}
            />
          ))}
        </div>
      )}

      {/* Drawer */}
      {drawer && (
        <RatePeriodDrawer
          type={type}
          config={config}
          marketplace={marketplace}
          sellerAccount={sellerAccount}
          initialCategory={drawer.category}
          currentRows={drawer.rows}
          editPeriodIds={drawer.editIds}
          initialFrom={drawer.initialFrom}
          initialTo={drawer.initialTo}
          isCopy={drawer.isCopy}
          copyFromCategory={drawer.copyFromCat}
          onClose={() => setDrawer(null)}
          onSaved={() => { setDrawer(null); load(); if (onCoverageDirty) onCoverageDirty(); }}
        />
      )}

      <ConfirmDialog
        open={!!confirm}
        busy={confirmBusy}
        title={confirm?.title}
        description={confirm?.description}
        confirmLabel={confirm?.confirmLabel}
        variant={confirm?.variant}
        onClose={() => { if (!confirmBusy) setConfirm(null); }}
        onConfirm={async () => { await confirm?.action?.(); }}
      />
    </div>
  );
}

/* ─── Account manager pill strip ─────────────────────────────── */
function AccountStrip({ marketplace, value, onChange }) {
  const [accounts, setAccounts]   = useState([]);
  const [loading, setLoading]     = useState(false);
  const [showAdd, setShowAdd]     = useState(false);
  const [newName, setNewName]     = useState('');
  const [adding, setAdding]       = useState(false);
  const [addErr, setAddErr]       = useState(null);
  // Styled confirm dialog state for destructive flows.
  const [confirm, setConfirm]     = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const mpMeta    = MARKETPLACES.find(m => m.id === marketplace) || MARKETPLACES[0];
  const isMyntra  = marketplace === 'myntra' || marketplace === 'myntra_vb' || marketplace === 'myntra_ej';
  const isDedicatedMyntra = marketplace === 'myntra_vb' || marketplace === 'myntra_ej';
  const accountLabel = isMyntra ? 'Myntra account' : 'Account';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchMarketplaceAccounts(marketplace);
      setAccounts(d.accounts || []);
      // If current selection is gone or invalid, set to first available or default
      if (d.accounts?.length > 0 && !d.accounts.some(a => a.account_id === value)) {
        onChange(d.accounts[0].account_id);
      } else if (!value) {
        onChange('default');
      }
    } catch {}
    setLoading(false);
  }, [marketplace, value, onChange]);

  useEffect(() => { load(); }, [load]);

  async function handleAdd() {
    if (!newName.trim()) return;
    setAdding(true); setAddErr(null);
    try {
      await createMarketplaceAccount({ marketplace, account_id: newName.trim(), display_name: newName.trim() });
      setNewName(''); setShowAdd(false);
      await load();
    } catch (e) {
      setAddErr(e.response?.data?.error || e.message);
    }
    setAdding(false);
  }

  async function handleRemove(account) {
    if (account.account_id === 'default' || account.account_id === 'myntra_vb' || account.account_id === 'myntra_ej') return;
    setConfirm({
      title: `Remove ${accountLabel}?`,
      description: `Remove "${account.display_name}" from ${mpMeta.label}.\n\nRate card data for this account is NOT deleted — only the account label is removed.`,
      variant: 'danger',
      confirmLabel: 'Remove account',
      action: async () => {
        setConfirmBusy(true);
        try {
          // The /accounts GET returns { account_id, display_name } only.
          // There is no `id` field, so passing account.id would hit the
          // backend as /accounts/undefined and silently no-op. Pass
          // account_id (the business key) and the marketplace so the
          // server can scope the DELETE correctly when the user is on a
          // non-default marketplace.
          await deleteMarketplaceAccount(account.account_id, marketplace);
          if (value === account.account_id) onChange('default');
          await load();
          setConfirm(null);
        } catch (e) {
          setAddErr(e.response?.data?.error || e.message);
        } finally {
          setConfirmBusy(false);
        }
      },
    });
  }

  if (loading) return <div className="h-8 bg-surface-container rounded-full animate-pulse w-40" />;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[10px] font-bold text-outline uppercase tracking-widest mr-1">{accountLabel}:</span>
      {accounts.map(a => (
        <div key={a.account_id} className="relative group">
          <button
            onClick={() => onChange(a.account_id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${
              value === a.account_id
                ? 'bg-primary text-white border-primary shadow-sm'
                : 'bg-surface text-secondary border-border hover:border-primary hover:text-primary'
            }`}
          >
            {a.account_id === 'default' ? `${mpMeta.emoji} ${a.display_name}` : `${isMyntra ? '🏷️' : '🏢'} ${a.display_name}`}
          </button>
          {a.account_id !== 'default' && a.account_id !== 'myntra_vb' && a.account_id !== 'myntra_ej' && (
            <button
              onClick={() => handleRemove(a)}
              className="absolute -top-1 -right-1 w-4 h-4 bg-rose-500 text-white rounded-full text-[10px] hidden group-hover:flex items-center justify-center leading-none hover:bg-rose-600"
              title={`Remove ${accountLabel}`}
            >×</button>
          )}
        </div>
      ))}

      {/* Add account/brand */}
      {!isDedicatedMyntra && (
        showAdd ? (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
              placeholder={`${accountLabel} name…`}
              className="text-xs border-2 border-primary rounded-full px-3 py-1.5 w-36 outline-none focus:border-primary"
            />
            <button type="button" onClick={handleAdd} disabled={adding} aria-busy={adding}
              className="inline-flex items-center justify-center rounded-full bg-primary px-2.5 py-1.5 text-xs font-bold text-white hover:bg-primary disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2">
              <span className={`material-symbols-outlined text-[14px] ${adding ? 'animate-spin' : ''}`} aria-hidden="true">
                {adding ? 'progress_activity' : 'check'}
              </span>
            </button>
            <button type="button" onClick={() => { setShowAdd(false); setNewName(''); setAddErr(null); }}
              aria-label="Cancel adding account"
              className="inline-flex items-center justify-center border border-border rounded-full px-2.5 py-1.5 text-xs text-secondary hover:bg-surface-container-low focus-visible:ring-2 focus-visible:ring-primary/40">
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">close</span>
            </button>
            {addErr && <span className="text-[10px] text-rose-600">{addErr}</span>}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1 rounded-full border-2 border-dashed border-border px-3 py-1.5 text-xs font-semibold text-outline transition-colors hover:border-primary hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">add</span>
            Add {accountLabel}
          </button>
        )
      )}

      <ConfirmDialog
        open={!!confirm}
        busy={confirmBusy}
        title={confirm?.title}
        description={confirm?.description}
        confirmLabel={confirm?.confirmLabel}
        variant={confirm?.variant}
        onClose={() => { if (!confirmBusy) setConfirm(null); }}
        onConfirm={async () => { await confirm?.action?.(); }}
      />
    </div>
  );
}

/* ─── Per-fee-type coverage panel (shown inside each tab only) ─── */
function FeeTypeCoveragePanel({ feeType, coverage, marketplace, sellerAccount, onConfigureCategory }) {
  const [open, setOpen] = useState(true);

  if (coverage === undefined) {
    return <div className="h-12 animate-pulse bg-surface-container rounded-xl mb-4" />;
  }

  if (!coverage?.gaps) return null;

  const missing = coverage.gaps[feeType] || [];
  const cfg = FEE_CONFIGS[feeType];
  const mpMeta = MARKETPLACES.find(m => m.id === marketplace) || MARKETPLACES[0];
  const brandGaps = coverage.brandGaps || {};
  const isOptional = feeType === 'franchise_fee';
  const showBrandGaps = feeType === 'commission';

  if (missing.length === 0) {
    return (
      <div className="flex items-center gap-2.5 px-4 py-3 mb-4 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-700">
        <svg className="w-4 h-4 shrink-0 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>
          <strong>{cfg.title}</strong> fully configured for <strong>{mpMeta.label}</strong>
          {coverage.allCategories?.length > 0 && <> · all {coverage.allCategories.length} categories covered</>}
        </span>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50/50 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-orange-50 transition-colors text-left"
        onClick={() => setOpen(o => !o)}
      >
        <div className="w-8 h-8 rounded-lg bg-orange-500 flex items-center justify-center shrink-0 text-white text-sm">
          {cfg.icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-orange-900">
            {missing.length} categor{missing.length !== 1 ? 'ies' : 'y'} missing {cfg.title}
            {isOptional && <span className="ml-1.5 text-[10px] font-semibold text-orange-600 uppercase">(optional)</span>}
          </p>
          <p className="text-[11px] text-orange-700 mt-0.5">
            {mpMeta.emoji} {mpMeta.label} · click a category below to add its rate period
          </p>
        </div>
        <span className="shrink-0 text-[11px] text-orange-600 font-semibold flex items-center gap-1">
          {open ? 'Hide' : 'Show'}
          <svg className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-orange-100/80">
          <div className="flex flex-wrap items-center justify-between gap-3 py-2">
            <p className="text-[11px] text-secondary">
              Missing {cfg.title.toLowerCase()} defaults to zero in reconciliation — configure each category.
            </p>
            {feeType === 'commission' && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    const { downloadRateCardTemplate } = await import('../api/client');
                    const blob = await downloadRateCardTemplate(marketplace, sellerAccount);
                    const url = window.URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.setAttribute('download', `RateCard_Commission_Template.xlsx`);
                    document.body.appendChild(link);
                    link.click();
                    link.parentNode.removeChild(link);
                  } catch(e) {
                    console.error('Failed to download template', e);
                    alert('Failed to download template: ' + (e.message || 'Unknown error'));
                  }
                }}
                className="shrink-0 flex items-center gap-1.5 text-[10px] font-semibold text-primary bg-primary-container/50 hover:bg-primary-container px-2.5 py-1 rounded transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download Excel Template (FSN/Category/Brand)
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {missing.map(cat => {
              const bGaps = showBrandGaps ? (brandGaps[cat] || []) : [];
              return (
                <div key={cat} className="rounded-lg border border-orange-200/80 bg-surface p-2.5 hover:border-orange-300 transition-colors">
                  <button
                    type="button"
                    onClick={() => onConfigureCategory(cat)}
                    className="w-full flex items-center justify-between gap-2 text-left group"
                  >
                    <span className="text-xs font-semibold text-ink truncate">{cat}</span>
                    <span className="shrink-0 text-[10px] font-bold text-primary bg-primary-container px-2 py-0.5 rounded-md group-hover:bg-primary-container">
                      + Add
                    </span>
                  </button>
                  {bGaps.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-border flex flex-wrap gap-1">
                      {bGaps.map(brand => (
                        <span
                          key={brand}
                          className="px-1.5 py-0.5 bg-rose-50 border border-rose-200 text-rose-600 text-[10px] rounded font-semibold"
                          title={`${brand} has no commission rate for ${cat}`}
                        >
                          {brand}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Marketplace coverage summary (compact strip) ───────────── */
function MarketplaceCoverageSummary({ coverage, marketplace }) {
  if (!coverage?.gaps) return null;

  const mpMeta = MARKETPLACES.find(m => m.id === marketplace) || MARKETPLACES[0];
  const perType = TABS.map(type => ({
    type,
    count: coverage.gaps[type]?.length || 0,
    cfg: FEE_CONFIGS[type],
  }));
  const totalRequired = REQUIRED_FEE_TYPES.reduce((s, t) => s + (coverage.gaps[t]?.length || 0), 0);
  const totalOptional = coverage.gaps.franchise_fee?.length || 0;

  if (totalRequired === 0 && totalOptional === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-700 font-medium">
        <span className="text-base">{mpMeta.emoji}</span>
        <span><strong>{mpMeta.label}</strong> — all fee types configured across {coverage.allCategories?.length || 0} categories</span>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 bg-surface-container-low border border-border rounded-xl">
      <p className="text-[10px] font-bold text-outline uppercase tracking-wider mb-2">
        {mpMeta.emoji} {mpMeta.label} — missing configs by fee type
      </p>
      <div className="flex flex-wrap gap-2">
        {perType.map(({ type, count, cfg }) => (
          <span
            key={type}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold border ${
              count > 0
                ? 'bg-orange-50 border-orange-200 text-orange-800'
                : 'bg-emerald-50 border-emerald-200 text-emerald-700'
            }`}
          >
            <span>{cfg.icon}</span>
            {cfg.title}
            <span className={`min-w-[18px] h-[18px] px-1 rounded-full text-[10px] flex items-center justify-center ${
              count > 0 ? 'bg-orange-500 text-white' : 'bg-emerald-500 text-white'
            }`}>
              {count > 0 ? count : '✓'}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function RateCardVersionPanel({ marketplace, sellerAccount, onRestored }) {
  const [versions, setVersions] = useState([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await fetchRateCardVersions(marketplace, sellerAccount);
      setVersions(data.versions || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }, [marketplace, sellerAccount]);

  useEffect(() => { load(); }, [load]);

  const createVersion = async () => {
    setBusy('create');
    setError('');
    try {
      await createRateCardVersion({
        marketplace,
        seller_account: sellerAccount,
        version_name: name.trim() || undefined,
        effective_from: new Date().toISOString().slice(0, 10),
      });
      setName('');
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy('');
    }
  };

  const act = async (version, mode) => {
    setBusy(`${mode}:${version.id}`);
    setError('');
    try {
      if (mode === 'publish') await publishRateCardVersion(version.id);
      else await rollbackRateCardVersion(version.id);
      await load();
      onRestored?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4 md:flex-row md:items-center">
        <div className="flex-1">
          <p className="text-sm font-bold text-ink">Rate-card versions</p>
          <p className="mt-0.5 text-xs text-outline">Snapshot current rates before changes, publish approved versions, or roll back safely.</p>
        </div>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="Version name"
            className="min-w-0 rounded-lg border border-border px-3 py-2 text-xs outline-none focus:border-primary"
          />
          <button
            onClick={createVersion}
            disabled={busy === 'create'}
            className="shrink-0 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
          >
            Save snapshot
          </button>
        </div>
      </div>
      {error && <p className="border-b border-rose-100 bg-rose-50 px-5 py-2 text-xs font-semibold text-rose-700">{error}</p>}
      <div className="divide-y divide-border">
        {versions.slice(0, 6).map(version => (
          <div key={version.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold text-ink">{version.version_name}</p>
              <p className="mt-0.5 text-[10px] text-outline">
                {new Date(version.created_at).toLocaleString('en-IN')}
                {version.effective_from ? ` · Effective ${String(version.effective_from).slice(0, 10)}` : ''}
              </p>
            </div>
            <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${
              version.status === 'published'
                ? 'bg-emerald-50 text-emerald-700'
                : version.status === 'archived'
                  ? 'bg-surface-container text-secondary'
                  : 'bg-amber-50 text-amber-700'
            }`}>
              {version.status}
            </span>
            {version.status === 'draft' && (
              <button
                onClick={() => act(version, 'publish')}
                disabled={!!busy}
                className="rounded-lg border border-emerald-200 px-2.5 py-1.5 text-[10px] font-bold text-emerald-700 hover:bg-emerald-50 disabled:opacity-40"
              >
                Publish
              </button>
            )}
            <button
              onClick={() => act(version, 'rollback')}
              disabled={!!busy}
              className="rounded-lg border border-border px-2.5 py-1.5 text-[10px] font-bold text-secondary hover:bg-surface-container-low disabled:opacity-40"
            >
              Restore
            </button>
          </div>
        ))}
        {!versions.length && <p className="px-5 py-4 text-xs text-outline">No snapshots yet. Save one before your next rate change.</p>}
      </div>
    </div>
  );
}

/* ─── Main page ───────────────────────────────────────────────── */
function RateCardNotificationPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchRateCardNotificationStatus());
      setMessage('');
    } catch (error) {
      setMessage(error.response?.data?.error || error.message || 'Could not load email status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function sendTest() {
    setTesting(true); setMessage('');
    try {
      const result = await sendRateCardNotificationTest();
      const status = result.event?.status || 'unknown';
      const testMessage = status === 'accepted'
        ? 'Test accepted by Resend. Check payments@youthnic.shop inbox.'
        : `Test status: ${status}${result.event?.error_message ? ` — ${result.event.error_message}` : ''}`;
      await refresh();
      setMessage(testMessage);
    } catch (error) {
      setMessage(error.response?.data?.error || error.message || 'Test email failed');
    } finally {
      setTesting(false);
    }
  }

  const statusStyle = status => ({
    accepted: 'bg-emerald-100 text-emerald-700',
    skipped: 'bg-amber-100 text-amber-700',
    failed: 'bg-rose-100 text-rose-700',
  }[status] || 'bg-surface-container text-secondary');

  return (
    <div className="bg-surface rounded-xl border border-border/80 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-ink">Rate-card change email</p>
          <p className="text-xs text-secondary mt-0.5">Every add, edit, deletion, rate period, publish, and rollback is logged and notified.</p>
        </div>
        <button type="button" onClick={sendTest} disabled={loading || testing || !data?.configured}
          className="px-3 py-2 rounded-lg bg-primary text-white text-xs font-bold hover:bg-primary disabled:opacity-50 transition-colors">
          {testing ? 'Sending test…' : 'Send test email'}
        </button>
      </div>
      <div className="px-5 py-3 bg-surface-container-low/70 text-xs">
        {loading ? <span className="text-outline">Checking Resend setup…</span> : data ? (
          <div className="space-y-1">
            <p className={data.configured ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'}>
              {data.configured ? `Ready to notify ${data.recipient}` : `Not ready — add ${data.missing.join(' and ')} on the VPS`}
            </p>
            <p className="text-secondary">{data.deliveryMeaning}</p>
          </div>
        ) : <span className="text-rose-600">{message || 'Email status unavailable'}</span>}
        {message && data && <p className="mt-2 text-secondary">{message}</p>}
      </div>
      {!!data?.events?.length && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-surface border-b border-border text-secondary">
              <tr><th className="text-left font-semibold px-5 py-2">When</th><th className="text-left font-semibold px-3 py-2">Event</th><th className="text-left font-semibold px-3 py-2">Status</th><th className="text-left font-semibold px-3 py-2">Details</th></tr>
            </thead>
            <tbody>
              {data.events.slice(0, 5).map(event => (
                <tr key={event.id} className="border-b border-border last:border-0">
                  <td className="px-5 py-2 text-secondary whitespace-nowrap">{event.created_at ? new Date(event.created_at).toLocaleString('en-IN') : '—'}</td>
                  <td className="px-3 py-2 text-ink">{event.event_type.replace(/_/g, ' ')}</td>
                  <td className="px-3 py-2"><span className={`inline-flex px-2 py-0.5 rounded-full font-bold ${statusStyle(event.status)}`}>{event.status}</span></td>
                  <td className="px-3 py-2 text-secondary max-w-xs truncate" title={event.error_message || event.subject}>{event.error_message || event.subject}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function RateCardConfigPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [marketplace, setMarketplace] = useState('flipkart');
  const [sellerAccount, setAccount] = useState('default');
  const [tab, setTab] = useState(TABS[0]);
  const [coverage, setCoverage] = useState(undefined);
  const [coverageVer, setCoverageVer] = useState(0);
  const [showHelp, setShowHelp] = useState(false);

  const handleCoverageDirty = useCallback(() => {
    setCoverageVer(v => v + 1);
  }, []);

  const handleMarketplaceChange = (mp) => {
    const meta = MARKETPLACES.find(m => m.id === mp);
    setMarketplace(mp);
    setAccount(meta?.defaultAccount || 'default');
  };

  // Load coverage whenever marketplace, account, or coverageVer changes
  useEffect(() => {
    setCoverage(undefined);
    let cancelled = false;
    Promise.all([
      fetchRateCardCategoryList(marketplace, sellerAccount, true),
      ...TABS.map(type =>
        fetchRateCardConfig(type, marketplace, sellerAccount).catch(() => ({ rows: [] }))
      ),
    ]).then(([catData, ...configs]) => {
      if (cancelled) return;
      const allCats = (catData.categories || []).filter(Boolean).sort();
      const gaps    = {};
      // Compute "active for today" from start_date / end_date rather than a
      // non-existent `is_active` column. rowStatus(r) does the right thing
      // for legacy rows that have NULL start_date (they stay active).
      TABS.forEach((type, i) => {
        const rows = configs[i]?.rows || configs[i] || [];
        const activeCats = new Set(
          rows.filter(r => rowStatus(r) === 'active' && !r.brand_name).map(r => r.category)
        );
        gaps[type] = allCats.filter(c => !activeCats.has(c));
      });
      // The /config/categories endpoint returns brand names as a flat
      // `brands` array (because it doesn't know which category each brand
      // belongs to from this query). The page consumes `brandGaps`, so we
      // surface a global brand list under a synthetic `*` key. Each
      // category card can then decide whether to show the chip row.
      const brandList = catData.brands || [];
      const brandGaps = brandList.length > 0 ? { '*': brandList } : {};
      setCoverage({ allCategories: allCats, gaps, brandGaps });
    }).catch(err => {
      console.error('Failed to load coverage', err);
      if (!cancelled) setCoverage(null);
    });
    return () => { cancelled = true; };
  }, [marketplace, sellerAccount, coverageVer]);

  // Make sure tab is valid if marketplace changes (if we had different tabs)
  useEffect(() => {
    if (!TABS.includes(tab)) setTab(TABS[0]);
  }, [marketplace, tab]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <PageHeader 
        title="Rate Card Config" 
        subtitle="Manage fee rates per marketplace & category · Saved to PostgreSQL · Used in reconciliation"
        actions={<div />}
      />

      <div className="flex flex-col md:flex-row gap-6">
        <div className="w-full md:w-64 shrink-0 space-y-6">
          <div className="bg-surface rounded-xl border border-border/80 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-border">
              <p className="text-[10px] font-bold text-outline uppercase tracking-widest mb-3">Marketplace</p>
              <div className="flex gap-2 flex-wrap">
                {MARKETPLACES.map(mp => (
                  <button
                    key={mp.id}
                    onClick={() => handleMarketplaceChange(mp.id)}
                    className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-semibold transition-all border ${
                      marketplace === mp.id
                        ? 'bg-primary text-white border-primary shadow-sm'
                        : 'bg-surface text-secondary border-border hover:border-border hover:bg-surface-container-low'
                    }`}
                  >
                    <span className="text-base leading-none">{mp.emoji}</span>
                    {mp.label}
                  </button>
                ))}
              </div>
              {MARKETPLACES.find(m => m.id === marketplace)?.note && (
                <p className="text-[11px] text-outline mt-2">{MARKETPLACES.find(m => m.id === marketplace).note}</p>
              )}
            </div>
            <div className="px-5 py-3 bg-surface-container-low/50">
              <AccountStrip marketplace={marketplace} value={sellerAccount} onChange={setAccount} />
            </div>
          </div>
        </div>

        <div className="flex-1 space-y-6 min-w-0">
          <>
            <RateCardVersionPanel
              marketplace={marketplace}
              sellerAccount={sellerAccount}
              onRestored={handleCoverageDirty}
            />

              <div className="rounded-2xl border border-primary overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowHelp(v => !v)}
                  className="w-full px-5 py-3 flex items-center justify-between gap-3 bg-primary-container/60 hover:bg-primary-container transition-colors text-left"
                >
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="text-sm font-bold text-primary">How rate cards work</span>
                  </div>
                  <span className="text-xs text-primary font-semibold">{showHelp ? 'Hide' : 'Show guide'}</span>
                </button>
                {showHelp && (
                  <div className="px-5 py-4 bg-surface border-t border-primary text-xs text-secondary leading-relaxed space-y-2">
                    <p>① Pick marketplace and account above.</p>
                    <p>② Click <strong>Add Rate Period</strong> → select category → set dates → enter slabs → Save.</p>
                    <p>③ When rates change, add a new period — the old rate auto-closes. Past orders use the rate active on their order date.</p>
                    <p>④ Use <strong>Edit</strong> on any historical period to fix dates or values.</p>
                  </div>
                )}
              </div>

              {coverage !== null && (
                <MarketplaceCoverageSummary coverage={coverage} marketplace={marketplace} />
              )}

              <div id="fee-type-tabs" className="bg-surface rounded-xl border border-border/80 shadow-sm overflow-hidden">
                <div className="border-b border-border px-3 pt-3 flex gap-1 flex-wrap bg-surface-container-low/40">
                  {TABS.map(key => {
                    const cfg    = FEE_CONFIGS[key];
                    const color  = TAB_COLORS[key];
                    const isAct  = tab === key;
                    const gapCnt = coverage?.gaps?.[key]?.length || 0;
                    return (
                      <button key={key} onClick={() => setTab(key)}
                        className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-t-xl transition-all ${
                          isAct
                            ? `${ACTIVE_MAP[color]} -mb-px border border-b-white border-border`
                            : 'text-secondary hover:text-ink hover:bg-surface-container-low'
                        }`}>
                        <span>{cfg.icon}</span>
                        {cfg.title}
                        {gapCnt > 0 && (
                          <span className={`ml-0.5 min-w-[18px] h-[18px] px-1 text-[10px] font-bold rounded-full leading-none flex items-center justify-center ${
                            isAct ? 'bg-white/25 text-white' : 'bg-orange-500 text-white'
                          }`}>
                            {gapCnt}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <div className="p-5">
                  <FeeTypeView
                    key={`${tab}_${marketplace}_${sellerAccount}`}
                    type={tab}
                    marketplace={marketplace}
                    sellerAccount={sellerAccount}
                    coverage={coverage}
                    onCoverageDirty={handleCoverageDirty}
                  />
                </div>
              </div>
            </>
        </div>
      </div>
    </div>
  );
}
