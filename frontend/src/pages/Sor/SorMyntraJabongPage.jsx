import SorPageShell from './SorPageShell';

/**
 * SOR Level Payment Reco · Myntra Jabong India Private Limited.
 *
 * Per Pawan (2026-10-03): separate legal entity from the regular
 * Myntra marketplace. Different seller portal, different file format,
 * different fee / TDS / GST rules. NOT wired into myntraUpload.js.
 *
 * Data source: Excel upload from seller portal.
 * Phase 1 = build Excel parser + Data Hub upload card + populate the
 * KPI / invoice table on this sub-tab. Gated on Pawan sharing a sample
 * XLSX (header row + 5–10 data rows) so we can lock the column map.
 */
export default function SorMyntraJabongPage() {
  return (
    <SorPageShell
      portalId="myntra-jabong"
      portalLabel="SOR · Myntra Jabong India Private Limited"
      legalName="Myntra Jabong India Private Limited"
      portalAccount={null}
      phase="scaffold"
      phaseBadge="Phase 1 — Excel parser (data source confirmed)"
      description="Separate legal entity from the regular Myntra marketplace — Excel upload from seller portal"
      openQuestions={[
        'Share a sample XLSX (header row + 5–10 data rows) so we can lock the column map.',
        'Myntra Jabong India Private Limited seller-account identifier (e.g. MJIPL-SID-001) — single account or multiple brands?',
        'Invoice-number pattern (e.g. MJIPL/2025-26/000123) and period_from / period_to columns.',
        'Fee / commission / TDS / GST treatment — same as the regular Myntra pipeline, or different?',
        'Are Myntra Jabong invoices segregated by sub-account or single-pool?',
      ]}
      nextPhase="Phase 1 — Myntra Jabong end-to-end: Excel parser → Data Hub upload card → sor_invoice → KPI grid → drilldown drawer"
      cta="Source confirmed (separate legal entity, Excel upload from seller portal). Backend Excel parser + Data Hub upload card next. Send a sample XLSX so we can lock the column map."
    />
  );
}