import SorPageShell from './SorPageShell';
import { AWAITING_SAMPLE_BADGE, PENDING_UPLOAD_STREAMS } from './pendingStreams';

/**
 * SOR Level Payment Reco · Zepto Limited.
 *
 * Data source confirmed (2026-10-03): Excel upload from the seller portal.
 * Phase 3 builds the Excel parsers + Data Hub upload card, then surfaces the
 * parsed rows in sor_invoice / sor_invoice_line.
 */
export default function SorZeptoPage() {
  return (
    <SorPageShell
      portalId="zepto"
      portalLabel="SOR · Zepto Limited"
      legalName="Zepto Limited"
      statusBadge={AWAITING_SAMPLE_BADGE}
      description="Excel upload from the Zepto seller portal"
      setupNote="Data source confirmed: Excel upload from the Zepto seller portal. The invoice, payment, return and deduction parsers are built once a sample file (header row + 5–10 rows) is shared."
      uploadStreams={PENDING_UPLOAD_STREAMS}
      openQuestions={[
        'A sample XLSX (header row + 5–10 rows) for each of the invoice, payment, return and deduction files.',
        'Zepto seller-account identifier(s) — a single account or multiple brands?',
        'Invoice-number pattern (e.g. ZP/2025-26/000123) and the period_from / period_to columns.',
        'Fee lines — commission, fixed fee, collection fee, reverse shipping, TDS — or a different taxonomy?',
        'GST treatment — IGST / CGST+SGST / reverse charge?',
      ]}
    />
  );
}
