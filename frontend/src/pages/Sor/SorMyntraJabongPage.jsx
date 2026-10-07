import SorPageShell from './SorPageShell';
import { LIVE_UPLOADS_BADGE, UPLOAD_SETUP_NOTE, sorUploadStreams } from './streams';

/**
 * SOR Level Payment Reco · Myntra Jabong India Private Limited.
 *
 * Separate legal entity from the regular Myntra marketplace: different seller
 * portal, file format and fee / TDS / GST rules, and NOT wired into
 * myntraUpload.js (no 10708 / 45833 seller gate). Invoice, payment, payment
 * advice, return and deduction files upload through the generic SOR importer
 * (backend/services/sorUpload.js); a sample export only tunes its aliases.
 */
export default function SorMyntraJabongPage() {
  return (
    <SorPageShell
      portalId="myntra-jabong"
      portalLabel="SOR · Myntra Jabong India Private Limited"
      legalName="Myntra Jabong India Private Limited"
      statusBadge={LIVE_UPLOADS_BADGE}
      description="separate legal entity from the regular Myntra marketplace"
      setupNote={UPLOAD_SETUP_NOTE}
      uploadStreams={sorUploadStreams('Myntra Jabong')}
      openQuestions={[
        'To tune the importer to the portal’s own exports: one sample of each file (invoice, payment, payment advice, return, deduction).',
        'Seller-account identifier(s) — a single account or multiple brands?',
        'Invoice-number pattern and the period_from / period_to columns.',
        'Fee / commission / TDS / GST treatment — the same as the regular Myntra pipeline, or different?',
      ]}
    />
  );
}
