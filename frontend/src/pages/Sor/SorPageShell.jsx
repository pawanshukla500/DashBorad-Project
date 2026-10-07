import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import EmptyState from '../../components/EmptyState';
import Modal from '../../components/Modal';
import { fetchSorOutstanding, fetchSorInvoiceDetail } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useFilters } from '../../context/FilterContext';
import useFetch from '../../hooks/useFetch';
import useResettingPage from '../../hooks/useResettingPage';
import { OPS_ROLES } from '../../navigation';
import { hasRole } from '../../utils/roles';
import { formatDateFull, num as formatCount } from '../../utils/format';

const PAGE_SIZE = 50;
const STATUS_FILTERS = [
  { key: '', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'settled', label: 'Settled' },
  { key: 'overpaid', label: 'Overpaid' },
];
const STATUS_BADGES = {
  open: { label: 'Open', className: 'bg-primary-container text-on-primary-container' },
  settled: { label: 'Settled', className: 'bg-emerald-50 text-emerald-800' },
  overpaid: { label: 'Overpaid', className: 'bg-amber-50 text-amber-800' },
};
const LINE_SECTIONS = [
  ['sale', 'Sale lines'],
  ['payment', 'Payment lines'],
  ['return', 'Return lines'],
  ['deduction', 'Deduction lines'],
  ['other', 'Other lines'],
];
const FEE_LABELS = {
  commission: 'Commission',
  other_deductions: 'Other deductions',
  tcs: 'TCS',
  tds: 'TDS',
};

/**
 * Shared layout for the four SOR portal sub-tabs.
 *
 * Every portal reads the `sor_outstanding` view through
 * GET /api/sor/:portal/outstanding and renders:
 *   - KPI tiles + the sale − payment − return − deduction breakdown and aging
 *   - the 4 upload streams with their real status for this portal
 *   - the Outstanding Ledger (server-side search, status filter, sort, paging;
 *     honours the global date filter and Refresh button)
 *   - the invoice drilldown, lines grouped by line_type
 *
 * Token drift between the four sub-tabs is impossible because every portal
 * page passes through here.
 */
export default function SorPageShell({
  portalId,
  portalLabel,
  legalName,
  portalAccount = null,
  statusBadge,
  description,
  setupNote,
  uploadStreams = [],
  openQuestions = [],
}) {
  const { user } = useAuth();
  const canUpload = hasRole(user?.role, OPS_ROLES);
  const { filters, refreshKey } = useFilters();
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput.trim(), 300);
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState({ key: 'invoice_date', dir: 'desc' });
  const filterKey = JSON.stringify([portalId, portalAccount, filters.startDate, filters.endDate, search, status, sort]);
  const [page, setPage] = useResettingPage(filterKey);

  const { data, loading, refreshing, error, refetch } = useFetch(
    () => fetchSorOutstanding(portalId, {
      portal_account: portalAccount || undefined,
      from: filters.startDate || undefined,
      to: filters.endDate || undefined,
      invoice_no: search || undefined,
      status: status || undefined,
      sort: sort.key,
      dir: sort.dir,
      page,
      pageSize: PAGE_SIZE,
      _refresh: refreshKey || undefined,
    }),
    [filterKey, page, refreshKey],
  );

  const rows = data?.rows || [];
  const kpis = data?.kpis || null;
  // Invoices removed while a later page is open would leave that page empty.
  useEffect(() => {
    if (!loading && data && rows.length === 0 && page > 1) setPage(1);
  }, [loading, data, rows.length, page, setPage]);
  const total = Number(data?.total || 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const portalHasInvoices = Number(kpis?.invoiceCount || 0) > 0;
  const narrowed = Boolean(search || status || filters.startDate || filters.endDate);

  const [drawer, setDrawer] = useState(null);
  const drawerRequest = useRef(0);
  const openDrawer = useCallback(async (row) => {
    // Only the latest request may fill the drawer: a slow response for an
    // invoice the user already moved away from (or closed) is discarded.
    const requestId = ++drawerRequest.current;
    setDrawer({ row, loading: true });
    try {
      const detail = await fetchSorInvoiceDetail(portalId, row.invoice_id);
      if (requestId === drawerRequest.current) setDrawer({ row, detail });
    } catch (err) {
      if (requestId === drawerRequest.current) {
        setDrawer({ row, error: err?.response?.data?.error || err?.message || 'Failed to load invoice detail' });
      }
    }
  }, [portalId]);
  const closeDrawer = useCallback(() => {
    drawerRequest.current += 1;
    setDrawer(null);
  }, []);

  const toggleSort = key => setSort(previous => (
    previous.key === key ? { key, dir: previous.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }
  ));
  const clearFilters = () => {
    setSearchInput('');
    setStatus('');
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={portalLabel}
        subtitle={
          <>
            Invoice-level reconciliation for{' '}
            <span className="font-semibold text-ink">{legalName}</span>
            {portalAccount ? <> · account <span className="font-mono text-ink">{portalAccount}</span></> : null}
            {description ? <> · {description}</> : null}
          </>
        }
      >
        {statusBadge && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-container px-3 py-1 text-xs font-semibold text-on-primary-container">
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">{statusBadge.icon || 'flag'}</span>
            {statusBadge.label}
          </span>
        )}
      </PageHeader>

      {/* KPI tiles — whole portal (date filter applies; status filter does not). */}
      <section aria-label="Ledger summary" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-5">
        <KpiTile
          className="col-span-2 xl:col-span-1"
          label="Outstanding"
          value={kpis ? formatSignedINR(kpis.totalOutstanding) : '—'}
          tone={kpis && Number(kpis.totalOutstanding) > 0 ? 'warn' : 'neutral'}
          sub={kpis ? `${formatCount(kpis.invoicesWithOutstanding)} open invoice${Number(kpis.invoicesWithOutstanding) === 1 ? '' : 's'}` : null}
          loading={loading}
        />
        <KpiTile
          label="Invoices"
          value={kpis ? formatCount(kpis.invoiceCount) : '—'}
          sub={kpis && Number(kpis.overpaidInvoices) > 0 ? `${formatCount(kpis.overpaidInvoices)} overpaid` : null}
          loading={loading}
        />
        <KpiTile
          label="Overdue > 60 days"
          value={kpis ? formatSignedINR(Number(kpis.aging61to90) + Number(kpis.aging90plus)) : '—'}
          tone={kpis && Number(kpis.aging61to90) + Number(kpis.aging90plus) > 0 ? 'warn' : 'neutral'}
          loading={loading}
        />
        <KpiTile
          label="Invoices with variance"
          value={kpis ? formatCount(kpis.varianceInvoices) : '—'}
          sub="declared net ≠ sale − return − deduction"
          loading={loading}
        />
        <KpiTile
          label="Last upload"
          value={kpis?.lastUploadAt ? formatDateFull(kpis.lastUploadAt) : '—'}
          sub={kpis?.lastUploadAt ? formatTime(kpis.lastUploadAt) : 'no uploads yet'}
          loading={loading}
        />
      </section>

      {portalHasInvoices && (
        <section aria-label="Ledger breakdown" className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-surface p-4">
            <h2 className="font-sans text-xs font-semibold uppercase tracking-wide text-outline">How outstanding is built</h2>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm tabular-nums sm:grid-cols-[1fr_auto]">
              <BreakdownRow label="Sale" value={kpis.totalSale} />
              <BreakdownRow label="− Payment" value={kpis.totalPayment} />
              <BreakdownRow label="− Return" value={kpis.totalReturn} />
              <BreakdownRow label="− Deduction" value={kpis.totalDeduction} />
              <BreakdownRow label="= Outstanding" value={kpis.totalOutstanding} strong />
            </dl>
          </div>
          <div className="rounded-xl border border-border bg-surface p-4">
            <h2 className="font-sans text-xs font-semibold uppercase tracking-wide text-outline">Open outstanding by age</h2>
            <AgingBars
              buckets={[
                ['0–30 days', kpis.aging0to30],
                ['31–60 days', kpis.aging31to60],
                ['61–90 days', kpis.aging61to90],
                ['90+ days', kpis.aging90plus],
              ]}
            />
          </div>
        </section>
      )}

      {/* Upload streams — what feeds this portal's ledger today. */}
      <section aria-label="Upload streams" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {uploadStreams.map(stream => (
          <UploadStream key={stream.key} stream={stream} canUpload={canUpload} />
        ))}
      </section>

      {setupNote && (
        <p className="rounded-xl border border-border bg-surface-container-low/60 px-4 py-3 text-sm text-secondary">
          {setupNote}
        </p>
      )}

      {/* Outstanding Ledger */}
      <section aria-label="Outstanding ledger" className="rounded-xl border border-border bg-surface">
        <header className="flex flex-col gap-3 border-b border-border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-sans text-sm font-semibold text-ink">Outstanding Ledger</h2>
            <p className="text-xs text-outline">Per invoice: sale − payment − return − deduction</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div role="group" aria-label="Filter by status" className="inline-flex rounded-lg border border-border p-0.5">
              {STATUS_FILTERS.map(option => (
                <button
                  key={option.key || 'all'}
                  type="button"
                  aria-pressed={status === option.key}
                  onClick={() => setStatus(option.key)}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                    status === option.key ? 'bg-primary text-on-primary' : 'text-secondary hover:bg-surface-container-low'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <input
              type="search"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search invoice number…"
              className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 font-sans text-sm sm:w-64"
              aria-label="Search invoice number"
            />
          </div>
        </header>

        {loading ? (
          <div className="px-4 py-12 text-center" role="status">
            <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-primary/20 border-t-primary" aria-hidden="true" />
            <p className="mt-2 text-sm text-outline">Loading outstanding ledger…</p>
          </div>
        ) : error && !data ? (
          <div className="px-4 py-12 text-center" role="alert">
            <span className="material-symbols-outlined text-[28px] text-outline" aria-hidden="true">error</span>
            <p className="mt-2 text-sm text-secondary">{error}</p>
            <button
              type="button"
              onClick={refetch}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-primary hover:bg-surface-container-low"
            >
              Retry
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-6">
            {narrowed ? (
              <div className="py-8 text-center" role="status">
                <p className="text-sm text-secondary">
                  No invoices match {search ? <>“<span className="font-mono">{search}</span>”</> : 'these filters'}.
                </p>
                {(search || status) && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-primary hover:bg-surface-container-low"
                  >
                    Clear search and status
                  </button>
                )}
              </div>
            ) : (
              <EmptyState
                title="No invoices in the ledger yet"
                message={`Invoices for ${legalName} appear here once their file is imported.`}
                uploadHint={null}
                actionTo={canUpload ? uploadStreams.find(stream => stream.to)?.to || null : null}
                actionLabel="Upload invoices"
              />
            )}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto" aria-busy={refreshing}>
              <table className="min-w-full text-sm">
                <caption className="sr-only">Outstanding ledger for {legalName}</caption>
                <thead className="bg-surface-container-low/60">
                  <tr className="text-left font-sans text-xs font-semibold uppercase tracking-wide text-outline">
                    <SortableHeader label="Invoice" sortKey="invoice_no" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Date" sortKey="invoice_date" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Sale ₹" sortKey="sale_total" sort={sort} onSort={toggleSort} align="right" />
                    <th scope="col" className="px-3 py-2 text-right">Payment ₹</th>
                    <th scope="col" className="px-3 py-2 text-right">Return ₹</th>
                    <th scope="col" className="px-3 py-2 text-right">Deduction ₹</th>
                    <SortableHeader label="Outstanding ₹" sortKey="outstanding" sort={sort} onSort={toggleSort} align="right" />
                    <SortableHeader label="Age" sortKey="age_days" sort={sort} onSort={toggleSort} align="right" />
                    <SortableHeader label="Variance ₹" sortKey="variance" sort={sort} onSort={toggleSort} align="right" />
                    <th scope="col" className="px-3 py-2">Status</th>
                    <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border font-sans tabular-nums">
                  {rows.map(row => {
                    const badge = STATUS_BADGES[row.ledger_status] || STATUS_BADGES.open;
                    const hasVariance = row.variance != null && Math.abs(Number(row.variance)) >= 1;
                    return (
                      <tr key={row.invoice_id} className="hover:bg-surface-container-low/40">
                        <td className="px-3 py-2 font-mono text-xs text-ink">{row.invoice_no}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-outline">{formatLedgerDate(row.invoice_date)}</td>
                        <td className="px-3 py-2 text-right">{formatSignedINR(row.sale_total)}</td>
                        <td className="px-3 py-2 text-right">{formatSignedINR(row.payment_total)}</td>
                        <td className="px-3 py-2 text-right">{formatSignedINR(row.return_total)}</td>
                        <td className="px-3 py-2 text-right">{formatSignedINR(row.deduction_total)}</td>
                        <td className={`px-3 py-2 text-right font-semibold ${row.ledger_status === 'open' ? 'text-primary' : 'text-ink'}`}>
                          {formatSignedINR(row.outstanding)}
                        </td>
                        <td className="px-3 py-2 text-right text-outline">{row.age_days == null ? '—' : `${row.age_days}d`}</td>
                        <td className={`px-3 py-2 text-right ${hasVariance ? 'font-semibold text-amber-800' : 'text-outline'}`}>
                          {row.variance == null ? '—' : formatSignedINR(row.variance)}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.className}`}>{badge.label}</span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => openDrawer(row)}
                            aria-label={`Open invoice ${row.invoice_no}`}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs font-semibold text-primary hover:bg-surface-container-low focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                          >
                            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">open_in_new</span>
                            Open
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-border bg-surface-container-low px-4 py-2.5 text-xs text-secondary">
              <span>
                {formatCount(total)} invoice{total === 1 ? '' : 's'}
                {error ? <span className="ml-2 text-primary" role="alert">· {error}</span> : null}
              </span>
              {pages > 1 && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={page <= 1 || refreshing}
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    className="rounded px-2.5 py-1 text-secondary hover:bg-surface-container disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="px-2 font-semibold text-ink" aria-live="polite">{page} / {pages}</span>
                  <button
                    type="button"
                    disabled={page >= pages || refreshing}
                    onClick={() => setPage(p => Math.min(pages, p + 1))}
                    className="rounded px-2.5 py-1 text-secondary hover:bg-surface-container disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </section>

      {openQuestions.length > 0 && (
        <details className="group rounded-xl border border-border bg-surface p-5">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-display text-base font-semibold text-ink">
            Portal onboarding — information still needed
            <span className="material-symbols-outlined text-[20px] text-outline transition-transform group-open:rotate-180" aria-hidden="true">expand_more</span>
          </summary>
          <ul className="mt-3 space-y-2 text-sm text-secondary">
            {openQuestions.map(question => (
              <li key={question} className="flex gap-3">
                <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                <span>{question}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <InvoiceDrawer drawer={drawer} onClose={closeDrawer} />
    </div>
  );
}

function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

function KpiTile({ label, value, sub, tone = 'neutral', loading, className = '' }) {
  return (
    <div className={`rounded-xl border border-border bg-surface p-4 ${className}`}>
      <p className="font-sans text-xs font-medium uppercase tracking-wide text-outline">{label}</p>
      <p className={`mt-2 font-display text-headline-md font-semibold tabular-nums ${tone === 'warn' ? 'text-primary' : 'text-ink'}`}>
        {loading ? '…' : value}
      </p>
      {sub && !loading && <p className="mt-1 text-[11px] text-outline">{sub}</p>}
    </div>
  );
}

function BreakdownRow({ label, value, strong = false }) {
  return (
    <>
      <dt className={strong ? 'border-t border-border pt-1.5 font-semibold text-ink' : 'text-secondary'}>{label}</dt>
      <dd className={`text-right ${strong ? 'border-t border-border pt-1.5 font-semibold text-ink' : 'text-ink'}`}>{formatSignedINR(value)}</dd>
    </>
  );
}

function AgingBars({ buckets }) {
  const max = Math.max(...buckets.map(([, value]) => Math.max(0, Number(value) || 0)), 0);
  return (
    <ul className="mt-3 space-y-2">
      {buckets.map(([label, value]) => {
        const amount = Math.max(0, Number(value) || 0);
        const width = amount > 0 && max > 0 ? Math.max(2, Math.round((amount / max) * 100)) : 0;
        return (
          <li key={label} className="grid grid-cols-[88px_1fr_auto] items-center gap-3 text-sm">
            <span className="text-secondary">{label}</span>
            <span className="h-2 overflow-hidden rounded-full bg-surface-container-low" aria-hidden="true">
              <span className="block h-full rounded-full bg-primary" style={{ width: `${width}%` }} />
            </span>
            <span className="text-right tabular-nums text-ink">{formatSignedINR(amount)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function UploadStream({ stream, canUpload }) {
  const live = stream.state === 'live';
  // Live streams without their own upload are derived from another file.
  const icon = !live ? 'schedule' : stream.to ? 'upload' : 'task_alt';
  const body = (
    <>
      <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full ${live ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container text-outline'}`}>
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">{icon}</span>
      </span>
      <p className="font-sans text-sm font-semibold text-ink">{stream.label}</p>
      <p className="text-[11px] text-outline">{stream.note}</p>
    </>
  );
  const base = 'flex flex-col items-start gap-1 rounded-xl border p-4 text-left';
  if (live && stream.to && canUpload) {
    return (
      <Link
        to={stream.to}
        className={`${base} border-border bg-surface transition-colors hover:border-primary/40 hover:bg-surface-container-low focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40`}
      >
        {body}
      </Link>
    );
  }
  return (
    <div className={`${base} ${live ? 'border-border bg-surface' : 'border-dashed border-border bg-surface-container-low/60'}`}>
      {body}
      {live && stream.to && !canUpload && <p className="text-[11px] text-outline">Uploads are done by operators.</p>}
    </div>
  );
}

function SortableHeader({ label, sortKey, sort, onSort, align = 'left' }) {
  const active = sort.key === sortKey;
  return (
    <th
      scope="col"
      className={`px-3 py-2 ${align === 'right' ? 'text-right' : ''}`}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-0.5 uppercase tracking-wide hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded ${active ? 'text-ink' : ''}`}
      >
        {label}
        <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
          {active ? (sort.dir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}
        </span>
      </button>
    </th>
  );
}

function InvoiceDrawer({ drawer, onClose }) {
  const invoice = drawer?.detail?.invoice;
  const lines = drawer?.detail?.lines || {};
  return (
    <Modal
      open={Boolean(drawer)}
      onClose={onClose}
      size="lg"
      title={`Invoice ${drawer?.row?.invoice_no || ''}`}
      description={drawer?.row ? `${formatLedgerDate(drawer.row.invoice_date)} · account ${drawer.row.portal_account}` : undefined}
    >
      {drawer?.loading ? (
        <p className="py-8 text-center text-sm text-outline" role="status">Loading invoice…</p>
      ) : drawer?.error ? (
        <p className="py-4 text-sm text-primary" role="alert">{drawer.error}</p>
      ) : invoice ? (
        <div className="space-y-5 text-sm">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
            <SummaryItem label="Outstanding" value={formatSignedINR(invoice.outstanding)} strong />
            <SummaryItem label="Status" value={(STATUS_BADGES[invoice.ledger_status] || STATUS_BADGES.open).label} />
            <SummaryItem label="Declared net payable" value={invoice.declared_net_payable == null ? '—' : formatSignedINR(invoice.declared_net_payable)} />
            <SummaryItem label="Variance" value={invoice.variance == null ? '—' : formatSignedINR(invoice.variance)} />
            <SummaryItem label="Expected net payable" value={formatSignedINR(invoice.expected_net_payable)} />
            <SummaryItem label="Period" value={invoice.period_from ? `${formatLedgerDate(invoice.period_from)} – ${formatLedgerDate(invoice.period_to)}` : '—'} />
            <SummaryItem label="Age" value={invoice.age_days == null ? '—' : `${invoice.age_days} days`} />
            <SummaryItem label="Last updated" value={invoice.last_activity_at ? formatDateFull(invoice.last_activity_at) : '—'} />
          </dl>
          {LINE_SECTIONS.map(([type, title]) => {
            const items = lines[type] || [];
            if (type === 'other' && items.length === 0) return null;
            return (
              <section key={type}>
                <h3 className="mb-2 font-sans text-xs font-semibold uppercase tracking-wide text-outline">
                  {title} ({items.length})
                </h3>
                {items.length === 0 ? (
                  <p className="text-xs text-outline">None recorded.</p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {items.map(line => (
                      <li key={line.id} className="flex justify-between gap-3 rounded-md bg-surface-container-low/60 px-2 py-1.5">
                        <span className="min-w-0 truncate">
                          <span className="font-mono text-ink">{lineLabel(line)}</span>
                          {lineDetail(line) && <span className="ml-2 text-outline">{lineDetail(line)}</span>}
                        </span>
                        <span className="shrink-0 tabular-nums text-ink">{formatSignedINR(line.gross_amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      ) : null}
    </Modal>
  );
}

function SummaryItem({ label, value, strong = false }) {
  return (
    <div>
      <dt className="text-outline">{label}</dt>
      <dd className={`mt-0.5 tabular-nums ${strong ? 'font-semibold text-ink' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}

function lineLabel(line) {
  const feeType = line.raw_payload?.fee_type;
  if (line.line_type === 'deduction' && feeType) return FEE_LABELS[feeType] || feeType;
  if (line.line_type === 'payment') return line.raw_payload?.payment_reference || 'Payment';
  return line.sku || line.order_id || line.vb_export_sku || `Line #${line.id}`;
}

function lineDetail(line) {
  if (line.line_type === 'payment') return line.raw_payload?.payment_date ? formatLedgerDate(line.raw_payload.payment_date) : null;
  if (line.line_type === 'deduction') return line.sku || line.order_id || null;
  return line.quantity ? `qty ${line.quantity}` : null;
}

// Signed rupee amount with a true minus sign: −₹1,234.00 rather than ₹-1,234.00.
function formatSignedINR(value) {
  const n = Number(value) || 0;
  const text = `₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return n < 0 ? `−${text}` : text;
}

// DATE columns arrive as 'YYYY-MM-DD'; parse them as local dates so the
// displayed day never shifts with the browser's timezone.
function formatLedgerDate(value) {
  if (!value) return '—';
  return formatDateFull(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}
