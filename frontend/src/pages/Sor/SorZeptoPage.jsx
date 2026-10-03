import SorPageShell from './SorPageShell';

/**
 * SOR Level Payment Reco · Zepto Limited.
 *
 * Data source confirmed (2026-10-03): Excel upload from seller portal.
 * Phase 3 = build the Excel parser + Data Hub upload card for the
 * "Zepto Invoices" file type, then surface the parsed rows in
 * sor_invoice / sor_invoice_line and wire the KPI grid.
 */
export default function SorZeptoPage() {
  return (
    <SorPageShell
      portalId="zepto"
      portalLabel="SOR · Zepto Limited"
      legalName="Zepto Limited"
      portalAccount={null}
      phase={3}
      phaseBadge="Phase 3 — Excel parser (data source confirmed)"
      dataSourceConfirmed={true}
      description="Invoice-level reconciliation for Zepto via Excel upload"
      openQuestions={[
        'Zepto seller-account identifier(s) — single Zepto account or multiple brands?',
        'Share a sample XLSX (header row + 5–10 rows) so we can lock the column layout.',
        'Invoice-number pattern (e.g. ZP/2025-26/000123) and period_from / period_to columns.',
        'Fee lines — commission + fixed fee + collection fee + reverse shipping + TDS, or a different fee taxonomy?',
        'GST treatment — IGST / CGST+SGST / reverse-charge — any state-level quirks?',
      ]}
      nextPhase="Phase 3 — Zepto end-to-end: Excel parser → Data Hub upload card → sor_invoice → KPI grid → drilldown drawer"
      cta="Source confirmed: Excel upload from seller portal. Backend Excel parser + Data Hub upload card next. Send a sample XLSX so we can lock the column map."
    />
  );
}