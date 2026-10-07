import SorPageShell from './SorPageShell';

/**
 * SOR Level Payment Reco · Reliance Retail Ltd (AJIO).
 *
 * Live (Phase 2): AJIO invoices are imported through the existing Data Hub
 * mp_invoices pipeline (`/upload?marketplace=ajio`). Every upload or delete
 * re-syncs the SOR ledger from the stored rows (backend/services/sorMirror.js):
 * sale / return lines per row, deduction lines per fee, and a payment line
 * from Amount Received, so all four streams come from the one invoice file.
 */
const UPLOAD_STREAMS = [
  { key: 'invoice', label: 'Invoice', state: 'live', to: '/upload?marketplace=ajio', note: 'AJIO invoice file in the Data Hub' },
  { key: 'payment', label: 'Payment', state: 'live', note: 'Amount Received column of the invoice file' },
  { key: 'return', label: 'Return', state: 'live', note: 'Reverse rows of the invoice file' },
  { key: 'deduction', label: 'Deductions', state: 'live', note: 'Commission, TCS, TDS and other deductions' },
];

export default function SorRelianceAjioPage() {
  return (
    <SorPageShell
      portalId="reliance-ajio"
      portalLabel="SOR · Reliance Retail Ltd (AJIO)"
      legalName="Reliance Retail Ltd (AJIO)"
      statusBadge={{ label: 'Live — AJIO invoice upload', icon: 'check_circle' }}
      description="fed by the AJIO invoice upload"
      setupNote="Every AJIO invoice upload or delete in the Data Hub refreshes this ledger automatically. Invoice lines link to AJIO orders when the file carries an order line or release ID."
      uploadStreams={UPLOAD_STREAMS}
      openQuestions={[
        'AJIO seller-account identifier(s) — a single AJIO account or multiple brands under Reliance Retail Ltd?',
        'Does AJIO issue one consolidated invoice per settlement, or one invoice per order?',
        'Do AJIO return rows carry a Return ID / order type column, or only a negative amount?',
        'TDS and GST treatment — the same as Myntra, or different?',
      ]}
    />
  );
}
