import SorPageShell from './SorPageShell';

/**
 * SOR Level Payment Reco · Cocoblu Retails (Cocoblu).
 *
 * Data source confirmed (2026-10-03): Excel upload from seller portal.
 * Phase 4 = build the Excel parser + Data Hub upload card for the
 * "Cocoblu Invoices" file type, then surface the parsed rows in
 * sor_invoice / sor_invoice_line and wire the KPI grid.
 */
export default function SorCocobluPage() {
  return (
    <SorPageShell
      portalId="cocoblu"
      portalLabel="SOR · Cocoblu Retails"
      legalName="Cocoblu Retails (Cocoblu)"
      portalAccount={null}
      phase={4}
      phaseBadge="Phase 4 — Excel parser (data source confirmed)"
      dataSourceConfirmed={true}
      description="Invoice-level reconciliation for Cocoblu via Excel upload"
      openQuestions={[
        'Cocoblu seller-account identifier(s) — single account or multiple brands?',
        'Share a sample XLSX (header row + 5–10 rows) so we can lock the column layout.',
        'Invoice-number pattern and period_from / period_to columns.',
        'Fee / commission / TDS lines — same taxonomy as Myntra/AJIO, or different?',
        'GST / reverse-charge treatment.',
      ]}
      nextPhase="Phase 4 — Cocoblu end-to-end: Excel parser → Data Hub upload card → sor_invoice → KPI grid → drilldown drawer"
      cta="Source confirmed: Excel upload from seller portal. Backend Excel parser + Data Hub upload card next. Send a sample XLSX so we can lock the column map."
    />
  );
}