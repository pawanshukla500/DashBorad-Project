// Upload streams of a SOR portal page. `key` is the backend stream
// (POST /api/sor/:portal/upload/:key); AJIO invoices use the AJIO importer.
const COMMON_STREAMS = [
  { key: 'payment', label: 'Payment', icon: 'payments', note: 'Bank receipts per invoice (UTR, date, amount)' },
  { key: 'payment_advice', label: 'Payment advice', icon: 'receipt_long', note: 'Remittance advice: amount paid, TDS and other deductions per invoice' },
  { key: 'return', label: 'Return', icon: 'assignment_return', note: 'Credit / debit notes for returned goods' },
  { key: 'deduction', label: 'Deductions', icon: 'remove_circle', note: 'Debit notes, claims, penalties and other charges' },
];

export function sorUploadStreams(portalName) {
  return [
    { key: 'invoice', label: 'Invoice', icon: 'request_quote', note: `Invoices raised to ${portalName} — upload these first` },
    ...COMMON_STREAMS,
  ];
}

export const AJIO_UPLOAD_STREAMS = [
  {
    key: 'invoice',
    mode: 'ajio-invoice',
    label: 'Invoice',
    icon: 'request_quote',
    note: 'AJIO invoice file — its Amount Received and reverse rows also post payments and returns',
  },
  ...COMMON_STREAMS,
];

export const LIVE_UPLOADS_BADGE = { label: 'Live — Excel uploads', icon: 'check_circle' };

export const UPLOAD_SETUP_NOTE = 'Download a template for the exact columns. A portal export works as-is when its column names match one of the accepted names listed in the template. Re-uploading a file updates the same lines instead of adding them twice; rows that cannot be matched are listed with the reason.';
