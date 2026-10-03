import SorPageShell from './SorPageShell';

/**
 * SOR Level Payment Reco · Reliance Retail Ltd (AJIO).
 *
 * Data source confirmed (2026-10-03): separate AJIO invoice upload
 * path already exists. Phase 2 = wire that upload path's parsed invoices
 * into sor_invoice / sor_invoice_line and surface per-invoice variance
 * in the SOR sub-tab.
 */
export default function SorRelianceAjioPage() {
  return (
    <SorPageShell
      portalId="reliance-ajio"
      portalLabel="SOR · Reliance Retail Ltd (AJIO)"
      legalName="Reliance Retail Ltd (AJIO)"
      portalAccount={null}
      phase="scaffold"
      phaseBadge="Phase 2 — Wire existing AJIO upload path"
      description="Invoice-level reconciliation for AJIO via the existing AJIO upload path"
      openQuestions={[
        'AJIO seller-account identifier(s) — single AJIO account or multiple brands under Reliance Retail Ltd?',
        'Invoice-number pattern and period_from / period_to columns — share a sample if you have it.',
        'Does AJIO issue one consolidated invoice per settlement or per-order invoices?',
        'Fee lines — same marketplace-fee taxonomy as Myntra, or different fee map?',
        'TDS + GST treatment — same as Myntra, or different?',
      ]}
      nextPhase="Phase 2 — AJIO end-to-end: wire existing upload path → sor_invoice → KPI grid → drilldown drawer"
      cta="Source confirmed: separate AJIO invoice upload path. Phase 2 = route the parsed rows into sor_invoice and surface variance."
    />
  );
}