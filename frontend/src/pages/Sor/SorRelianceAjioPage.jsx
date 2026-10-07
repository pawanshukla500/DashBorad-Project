import SorPageShell from './SorPageShell';
import { AJIO_UPLOAD_STREAMS } from './streams';

/**
 * SOR Level Payment Reco · Reliance Retail Ltd (AJIO).
 *
 * Live (Phase 2): AJIO invoices are imported through the existing Data Hub
 * mp_invoices pipeline (`/upload?marketplace=ajio`). Every upload or delete
 * re-syncs the SOR ledger from the stored rows (backend/services/sorMirror.js):
 * sale / return lines per row, deduction lines per fee, and a payment line
 * from Amount Received. Payment advices, payments, returns and deductions
 * upload through the generic SOR importer; payments are keyed by UTR, so one
 * that appears in both the invoice file and an advice is counted once.
 */

export default function SorRelianceAjioPage() {
  return (
    <SorPageShell
      portalId="reliance-ajio"
      portalLabel="SOR · Reliance Retail Ltd (AJIO)"
      legalName="Reliance Retail Ltd (AJIO)"
      statusBadge={{ label: 'Live — AJIO invoice upload', icon: 'check_circle' }}
      description="fed by the AJIO invoice upload"
      setupNote="AJIO invoices (also uploadable from the Data Hub) refresh this ledger automatically and link to AJIO orders when the file carries an order line or release ID. Payment advices, payments, returns and deductions are uploaded here; a payment that appears in both the invoice file and an advice (same UTR) is counted once."
      uploadStreams={AJIO_UPLOAD_STREAMS}
      openQuestions={[
        'AJIO seller-account identifier(s) — a single AJIO account or multiple brands under Reliance Retail Ltd?',
        'Does AJIO issue one consolidated invoice per settlement, or one invoice per order?',
        'Do AJIO return rows carry a Return ID / order type column, or only a negative amount?',
        'TDS and GST treatment — the same as Myntra, or different?',
      ]}
    />
  );
}
