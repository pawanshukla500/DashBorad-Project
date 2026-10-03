import { Link } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';

/**
 * Shared layout for the four SOR portal sub-tabs.
 *
 * Each portal has the same shape but different content blocks:
 *   - Phase 0 status (Scaffold / Phase 1 / Phase 2 / Phase 3 / Phase 4)
 *   - KPI grid placeholder
 *   - Invoice table placeholder
 *   - "Open questions for Pawan" checklist (mirrors the design doc)
 *
 * The component is intentionally presentational — data wiring lands in
 * each portal's own Phase PR. Keeping the shell centralised prevents
 * token drift across the four pages.
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

      <section aria-label="KPI grid placeholder" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Invoices',    value: '—' },
          { label: 'Variance',    value: '—' },
          { label: 'Unsettled',   value: '—' },
          { label: 'Last upload', value: '—' },
        ].map(kpi => (
          <div key={kpi.label} className="rounded-xl border border-border bg-surface p-4">
            <p className="font-sans text-xs font-medium text-outline uppercase tracking-wide">{kpi.label}</p>
            <p className="mt-2 font-display text-headline-md font-semibold tabular-nums text-ink">{kpi.value}</p>
          </div>
        ))}
      </section>

      <section aria-label="Invoice table placeholder" className="rounded-xl border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="font-sans text-sm font-semibold text-ink">Invoices</h3>
          <span className="font-mono text-xs text-outline">awaiting data source</span>
        </div>
        <div className="px-4 py-12 text-center">
          <span className="material-symbols-outlined text-[28px] text-outline" aria-hidden="true">receipt_long</span>
          <p className="mt-2 text-sm text-secondary">
            Invoice grain view lands when the portal parser is merged.
          </p>
        </div>
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
    </div>
  );
}