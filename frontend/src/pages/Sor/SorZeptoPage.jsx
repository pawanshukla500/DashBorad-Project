import SorPageShell from './SorPageShell';
import { LIVE_UPLOADS_BADGE, UPLOAD_SETUP_NOTE, sorUploadStreams } from './streams';

/**
 * SOR Level Payment Reco · Zepto Limited.
 *
 * Data source: Excel upload from the seller portal. Invoice, payment, payment
 * advice, return and deduction files upload through the generic SOR importer
 * (backend/services/sorUpload.js); a sample export only tunes its aliases.
 */
export default function SorZeptoPage() {
  return (
    <SorPageShell
      portalId="zepto"
      portalLabel="SOR · Zepto Limited"
      legalName="Zepto Limited"
      statusBadge={LIVE_UPLOADS_BADGE}
      description="Excel upload from the Zepto seller portal"
      setupNote={UPLOAD_SETUP_NOTE}
      uploadStreams={sorUploadStreams('Zepto')}
      openQuestions={[
        'To tune the importer to the portal’s own exports: one sample of each file (invoice, payment, payment advice, return, deduction).',
        'Zepto seller-account identifier(s) — a single account or multiple brands?',
        'Invoice-number pattern (e.g. ZP/2025-26/000123) and the period_from / period_to columns.',
        'Fee lines — commission, fixed fee, collection fee, reverse shipping, TDS — or a different taxonomy?',
        'GST treatment — IGST / CGST+SGST / reverse charge?',
      ]}
    />
  );
}
