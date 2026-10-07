import SorPageShell from './SorPageShell';
import { AWAITING_SAMPLE_BADGE, PENDING_UPLOAD_STREAMS } from './pendingStreams';

/**
 * SOR Level Payment Reco · Myntra Jabong India Private Limited.
 *
 * Separate legal entity from the regular Myntra marketplace: different seller
 * portal, file format and fee / TDS / GST rules, and NOT wired into
 * myntraUpload.js (no 10708 / 45833 seller gate). Data source: Excel upload
 * from the seller portal. Phase 1 builds the parser once a sample XLSX
 * (header row + 5–10 data rows) is shared.
 */
export default function SorMyntraJabongPage() {
  return (
    <SorPageShell
      portalId="myntra-jabong"
      portalLabel="SOR · Myntra Jabong India Private Limited"
      legalName="Myntra Jabong India Private Limited"
      statusBadge={AWAITING_SAMPLE_BADGE}
      description="separate legal entity from the regular Myntra marketplace"
      setupNote="Data source confirmed: Excel upload from the Myntra Jabong seller portal. The invoice, payment, return and deduction parsers are built once a sample file (header row + 5–10 rows) is shared."
      uploadStreams={PENDING_UPLOAD_STREAMS}
      openQuestions={[
        'A sample XLSX (header row + 5–10 data rows) for each of the invoice, payment, return and deduction files.',
        'Seller-account identifier(s) — a single account or multiple brands?',
        'Invoice-number pattern and the period_from / period_to columns.',
        'Fee / commission / TDS / GST treatment — the same as the regular Myntra pipeline, or different?',
      ]}
    />
  );
}
