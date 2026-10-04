import { Link } from 'react-router-dom';
import SorPageShell from './SorPageShell';

/**
 * SOR Level Payment Reco · Reliance Retail Ltd (AJIO).
 *
 * Data source confirmed (2026-10-03): separate AJIO invoice upload
 * path already exists (the generic mp_invoices pipeline accepts
 * marketplace='ajio'). Phase 2 = wire those parsed rows into
 * sor_invoice / sor_invoice_line so the SOR sub-tab lights up
 * automatically after every AJIO upload.
 *
 * Phase 2 wiring lives on the sor/phase-2-ajio-mirror branch.
 */
export default function SorRelianceAjioPage() {
  return (
    <SorPageShell
      portalId="reliance-ajio"
      portalLabel="SOR · Reliance Retail Ltd (AJIO)"
      legalName="Reliance Retail Ltd (AJIO)"
      portalAccount={null}
      phase={2}
      phaseBadge="Phase 2 — Wire existing AJIO upload path"
      dataSourceConfirmed={true}
      description="Invoice-level reconciliation for AJIO via the existing AJIO upload path"
      openQuestions={[
        'AJIO seller-account identifier(s) — single AJIO account or multiple brands under Reliance Retail Ltd?',
        'Invoice-number pattern and period_from / period_to columns — share a sample if you have it.',
        'Does AJIO issue one consolidated invoice per settlement or per-order invoices?',
        'Fee lines — same marketplace-fee taxonomy as Myntra, or different fee map?',
        'TDS + GST treatment — same as Myntra, or different?',
      ]}
      nextPhase="Phase 2 — AJIO end-to-end: wire existing upload path → sor_invoice → KPI grid → drilldown drawer"
      cta={
        <>
          Source confirmed: AJIO invoices flow through the existing{' '}
          <Link
            to="/upload?marketplace=ajio"
            className="font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
          >
            Data Hub → AJIO invoice upload
          </Link>
          . After each successful upload, the SOR mirror in{' '}
          <code className="font-mono text-[12px] text-secondary">backend/services/sorMirror.js</code>{' '}
          populates <code className="font-mono text-[12px] text-secondary">sor_invoice</code> +{' '}
          <code className="font-mono text-[12px] text-secondary">sor_invoice_line</code>; this sub-tab
          then renders the Outstanding Ledger automatically.
        </>
      }
    />
  );
}