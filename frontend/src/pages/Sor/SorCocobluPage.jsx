import SorPageShell from './SorPageShell';
import { AWAITING_SAMPLE_BADGE, PENDING_UPLOAD_STREAMS } from './pendingStreams';

/**
 * SOR Level Payment Reco · Cocoblu Retails (Cocoblu).
 *
 * Data source confirmed (2026-10-03): Excel upload from the seller portal.
 * Phase 4 builds the Excel parsers + Data Hub upload card, then surfaces the
 * parsed rows in sor_invoice / sor_invoice_line.
 */
export default function SorCocobluPage() {
  return (
    <SorPageShell
      portalId="cocoblu"
      portalLabel="SOR · Cocoblu Retails"
      legalName="Cocoblu Retails (Cocoblu)"
      statusBadge={AWAITING_SAMPLE_BADGE}
      description="Excel upload from the Cocoblu seller portal"
      setupNote="Data source confirmed: Excel upload from the Cocoblu seller portal. The invoice, payment, return and deduction parsers are built once a sample file (header row + 5–10 rows) is shared."
      uploadStreams={PENDING_UPLOAD_STREAMS}
      openQuestions={[
        'A sample XLSX (header row + 5–10 rows) for each of the invoice, payment, return and deduction files.',
        'Cocoblu seller-account identifier(s) — a single account or multiple brands?',
        'Invoice-number pattern and the period_from / period_to columns.',
        'Fee / commission / TDS lines — the same taxonomy as Myntra / AJIO, or different?',
        'GST / reverse-charge treatment.',
      ]}
    />
  );
}
