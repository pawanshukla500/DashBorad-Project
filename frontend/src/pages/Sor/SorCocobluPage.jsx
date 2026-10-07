import SorPageShell from './SorPageShell';
import { LIVE_UPLOADS_BADGE, UPLOAD_SETUP_NOTE, sorUploadStreams } from './streams';

/**
 * SOR Level Payment Reco · Cocoblu Retails (Cocoblu).
 *
 * Data source: Excel upload from the seller portal. Invoice, payment, payment
 * advice, return and deduction files upload through the generic SOR importer
 * (backend/services/sorUpload.js); a sample export only tunes its aliases.
 */
export default function SorCocobluPage() {
  return (
    <SorPageShell
      portalId="cocoblu"
      portalLabel="SOR · Cocoblu Retails"
      legalName="Cocoblu Retails (Cocoblu)"
      statusBadge={LIVE_UPLOADS_BADGE}
      description="Excel upload from the Cocoblu seller portal"
      setupNote={UPLOAD_SETUP_NOTE}
      uploadStreams={sorUploadStreams('Cocoblu')}
      openQuestions={[
        'To tune the importer to the portal’s own exports: one sample of each file (invoice, payment, payment advice, return, deduction).',
        'Cocoblu seller-account identifier(s) — a single account or multiple brands?',
        'Invoice-number pattern and the period_from / period_to columns.',
        'Fee / commission / TDS lines — the same taxonomy as Myntra / AJIO, or different?',
        'GST / reverse-charge treatment.',
      ]}
    />
  );
}
