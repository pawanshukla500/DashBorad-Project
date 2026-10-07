// Upload streams for a SOR portal whose parser is not built yet: all four
// streams are known but wait on a sample file from the seller portal.
export const PENDING_UPLOAD_STREAMS = [
  { key: 'invoice', label: 'Invoice', state: 'planned', note: 'Parser pending — sample file needed' },
  { key: 'payment', label: 'Payment', state: 'planned', note: 'Parser pending — sample file needed' },
  { key: 'return', label: 'Return', state: 'planned', note: 'Parser pending — sample file needed' },
  { key: 'deduction', label: 'Deductions', state: 'planned', note: 'Parser pending — sample file needed' },
];

export const AWAITING_SAMPLE_BADGE = { label: 'Awaiting sample file', icon: 'schedule' };
