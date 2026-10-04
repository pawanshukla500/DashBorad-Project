import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import EmptyState from '../../components/EmptyState';
import { fetchSorOutstanding, fetchSorInvoiceDetail } from '../../api/client';
import { currencyFull as formatINR, currencyCompact as formatINRCompact } from '../../utils/format';

/**
 * Shared layout for the four SOR portal sub-tabs.
 *
 * Each portal reads from the `sor_outstanding` view (defined by
 * `ensureSorLedgerSchema` in backend/db/initDb.js) and renders:
 *   - Phase 0.5 status (Scaffold / Phase N — work in progress / Awaiting data source)
 *   - 4-stream upload bar (disabled until Phase 1+ ships the parsers)
 *   - KPI grid reading from the view
 *   - Outstanding Ledger table (search, sort, paginate)
 *   - Invoice drilldown drawer grouped by line_type (sale / payment / return / deduction)
 *
 * Token drift between the four sub-tabs is impossible because every
 * portal page passes through here.
 */
export default function SorPageShell({
  portalLabel,
  portalId,
  portalAccount,
  legalName,
  phase,
  phaseBadge,
  dataSourceConfirmed = false,
  description,
  openQuestions,
  nextPhase,
  cta,
}) {
  const [outstanding, setOutstanding] = useState(null);
  const [kpis, setKpis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [drawerInvoice, setDrawerInvoice] = useState(null);

  const load = useCallback(async () => {
    if (!portalId) return;
    setLoading(true);
    setError(null);
    try {
      const params = {};
      if (portalAccount) params.portal_account = portalAccount;
      const data = await fetchSorOutstanding(portalId, params);
      setOutstanding(data.rows || []);
      setKpis(data.kpis || null);
    } catch (err) {
      // Empty state for new portal / unconfigured DB — render the
      // empty-state copy instead of an error banner.
      setOutstanding([]);
      setKpis(null);
      setError(err?.response?.data?.error || err?.message || 'Failed to load outstanding ledger');
    } finally {
      setLoading(false);
    }
  }, [portalId, portalAccount]);

  useEffect(() => {
    load();
  }, [load]);

  async function openDrawer(invoice) {
    try {
      const detail = await fetchSorInvoiceDetail(portalId, invoice.invoice_id);
      setDrawerInvoice(detail);
    } catch (err) {
      setDrawerInvoice({ error: err?.message, invoice });
    }
  }

  const filtered = (outstanding || []).filter(r => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      (r.invoice_no || '').toLowerCase().includes(s) ||
      (r.invoice_type || '').toLowerCase().includes(s)
    );
  });

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
        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-container px-3 py-1 text-xs font-semibold text-on-primary">
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">construction</span>
          {phaseBadge || 'Phase 0 — Scaffold'}
        </span>
      </PageHeader>

      <section
        aria-label={`${portalLabel} status`}
        className="rounded-xl border border-dashed border-border bg-surface-container-low/80 p-6"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
          <span
            aria-hidden="true"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary"
          >
            <span className="material-symbols-outlined text-[20px]">flag</span>
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="font-display text-base font-semibold text-ink">
              {phase === 'scaffold' && !dataSourceConfirmed
                ? 'Workspace scaffolded, data source needed'
                : `Phase ${phase} — work in progress`}
            </h3>
            <p className="mt-1 text-sm text-secondary max-w-[68ch]">
              {cta || 'This sub-tab is reserved for invoice-level reconciliation. The route is wired, the DB tables and indexes are in place, and the design system shell is live. Wire the per-portal data source and the KPI grid + invoice table will populate.'}
            </p>
            {nextPhase && (
              <p className="mt-2 text-xs text-outline">
                <span className="font-semibold text-ink">Next phase:</span> {nextPhase}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Upload bar (Phase 1+ will wire each card to its parser). */}
      <section aria-label="Upload streams" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {['Invoice', 'Payment', 'Return', 'Deductions'].map(label => (
          <button
            key={label}
            type="button"
            disabled
            title="Upload card arrives in Phase 1+"
            className="flex flex-col items-start gap-1 rounded-xl border border-dashed border-border bg-surface-container-low/60 p-4 text-left transition-colors disabled:cursor-not-allowed"
          >
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary-container text-on-primary">
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">upload</span>
            </span>
            <p className="font-sans text-sm font-semibold text-ink">{label}</p>
            <p className="font-mono text-[11px] text-outline">phase 1+</p>
          </button>
        ))}
      </section>

      {/* KPI grid — reads from sor_outstanding view. */}
      <section aria-label="KPI grid" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Invoices"
          value={kpis ? formatINRCompact(kpis.invoiceCount || 0) : '—'}
          loading={loading}
        />
        <KpiTile
          label="Outstanding"
          value={kpis ? formatINR(kpis.totalOutstanding || 0) : '—'}
          loading={loading}
          tone={kpis && kpis.totalOutstanding > 0 ? 'warn' : 'neutral'}
        />
        <KpiTile
          label="Outstanding > 0"
          value={kpis ? formatINRCompact(kpis.invoicesWithOutstanding || 0) : '—'}
          loading={loading}
          sub={kpis && kpis.overpaidInvoices ? `${kpis.overpaidInvoices} overpaid` : null}
        />
        <KpiTile
          label="Last upload"
          value="—"
          loading={loading}
          sub="from sor_upload_log"
        />
      </section>

      {/* Outstanding Ledger */}
      <section aria-label="Outstanding ledger" className="rounded-xl border border-border bg-surface">
        <header className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="font-sans text-sm font-semibold text-ink">Outstanding Ledger</h3>
            <p className="font-mono text-[11px] text-outline">per-invoice: sale − payment − return − deduction</p>
          </div>
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search invoice_no…"
            className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 font-sans text-sm sm:w-64"
            aria-label="Search invoices"
          />
        </header>

        {loading ? (
          <div className="px-4 py-12 text-center">
            <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-primary/20 border-t-primary" aria-hidden="true" />
            <p className="mt-2 text-sm text-outline">Loading outstanding ledger…</p>
          </div>
        ) : error ? (
          <div className="px-4 py-12 text-center">
            <span className="material-symbols-outlined text-[28px] text-outline" aria-hidden="true">error</span>
            <p className="mt-2 text-sm text-secondary">{error}</p>
            <button
              type="button"
              onClick={load}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-primary hover:bg-surface-container-low"
            >
              Retry
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-6">
            <EmptyState
              title="No invoices uploaded yet"
              message={`Upload an invoice file via the Data Hub to start the SOR ledger for ${legalName}.`}
              uploadHint={`Use the Invoice upload button (Phase 1+) to import an invoice XLSX. Once invoices are present, the Outstanding Ledger surfaces sale / payment / return / deduction totals and the per-invoice outstanding.`}
              actionTo="/upload"
              actionLabel="Open Data Hub"
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-surface-container-low/60">
                <tr className="text-left font-sans text-xs font-semibold uppercase tracking-wide text-outline">
                  <th className="px-3 py-2">InvoiceNo</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2 text-right">Sale ₹</th>
                  <th className="px-3 py-2 text-right">Payment ₹</th>
                  <th className="px-3 py-2 text-right">Return ₹</th>
                  <th className="px-3 py-2 text-right">Deduction ₹</th>
                  <th className="px-3 py-2 text-right">Outstanding ₹</th>
                  <th className="px-3 py-2 text-right">Age</th>
                  <th className="px-3 py-2 text-right">Variance</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border font-sans tabular-nums">
                {filtered.map(row => (
                  <tr key={row.invoice_id} className="hover:bg-surface-container-low/40">
                    <td className="px-3 py-2 font-mono text-xs">{row.invoice_no}</td>
                    <td className="px-3 py-2 text-outline">{row.invoice_date || '—'}</td>
                    <td className="px-3 py-2 text-right">{formatINR(row.sale_total || 0)}</td>
                    <td className="px-3 py-2 text-right">{formatINR(row.payment_total || 0)}</td>
                    <td className="px-3 py-2 text-right">{formatINR(row.return_total || 0)}</td>
                    <td className="px-3 py-2 text-right">{formatINR(row.deduction_total || 0)}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${(row.outstanding || 0) > 0 ? 'text-primary' : (row.outstanding || 0) < 0 ? 'text-emerald-700' : 'text-secondary'}`}>
                      {formatINR(row.outstanding || 0)}
                    </td>
                    <td className="px-3 py-2 text-right text-outline">{row.age_days ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-outline">{formatINR(row.variance || 0)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => openDrawer(row)}
                        className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs font-semibold text-primary hover:bg-surface-container-low"
                      >
                        <span className="material-symbols-outlined text-[14px]" aria-hidden="true">open_in_new</span>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-label="Open questions for Pawan" className="rounded-xl border border-border bg-surface p-5">
        <header className="flex items-center justify-between gap-2">
          <h3 className="font-display text-base font-semibold text-ink">Open questions for Pawan</h3>
          <Link
            to={`/sor/${portalId}`}
            className="font-mono text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
          >
            {`/sor/${portalId}`}
          </Link>
        </header>
        <ul className="mt-3 space-y-2 text-sm text-secondary">
          {openQuestions.map((q, i) => (
            <li key={i} className="flex gap-3">
              <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
              <span>{q}</span>
            </li>
          ))}
        </ul>
      </section>

      {drawerInvoice && (
        <Drawer onClose={() => setDrawerInvoice(null)} invoice={drawerInvoice} />
      )}
    </div>
  );
}

function KpiTile({ label, value, sub, tone = 'neutral', loading }) {
  const toneClass =
    tone === 'warn'
      ? 'text-primary'
      : tone === 'success'
      ? 'text-emerald-700'
      : 'text-ink';
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="font-sans text-xs font-medium text-outline uppercase tracking-wide">{label}</p>
      <p className={`mt-2 font-display text-headline-md font-semibold tabular-nums ${toneClass}`}>
        {loading ? '…' : value}
      </p>
      {sub && <p className="mt-1 font-mono text-[11px] text-outline">{sub}</p>}
    </div>
  );
}

function Drawer({ invoice, onClose }) {
  if (!invoice) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-ink/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Invoice drilldown"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-2xl flex-col bg-surface shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-wide text-outline">Invoice</p>
            <h3 className="font-display text-lg font-semibold text-ink">{invoice.invoice?.invoice_no || '—'}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drilldown"
            className="rounded-md border border-border bg-surface p-1.5 text-secondary hover:bg-surface-container-low"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">close</span>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm">
          {invoice.error ? (
            <p className="text-primary">{invoice.error}</p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <dt className="text-outline">Date</dt>
                <dd className="font-mono text-ink">{invoice.invoice?.invoice_date || '—'}</dd>
                <dt className="text-outline">Portal account</dt>
                <dd className="font-mono text-ink">{invoice.invoice?.portal_account || '—'}</dd>
                <dt className="text-outline">Declared net_payable</dt>
                <dd className="font-mono text-ink">{formatINR(invoice.invoice?.net_payable || 0)}</dd>
              </dl>
              <hr className="my-4 border-border" />
              {(['sale', 'payment', 'return', 'deduction']).map(t => (
                <section key={t} className="mb-4">
                  <h4 className="mb-2 font-sans text-xs font-semibold uppercase tracking-wide text-outline">
                    {t} lines ({invoice.lines?.[t]?.length || 0})
                  </h4>
                  {!invoice.lines?.[t]?.length ? (
                    <p className="text-xs text-outline">No {t} lines uploaded.</p>
                  ) : (
                    <ul className="space-y-1 font-mono text-xs">
                      {invoice.lines[t].map(ln => (
                        <li key={ln.id} className="flex justify-between gap-2 rounded-md bg-surface-container-low/60 px-2 py-1">
                          <span className="truncate">{ln.sku || ln.order_id || ln.vb_export_sku || `line #${ln.id}`}</span>
                          <span className="tabular-nums">{formatINR(ln.gross_amount || 0)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}