import { describe, expect, it } from 'vitest';
import {
  ledgerSourceFingerprint,
  parseLedgerUploadRow,
} from '../routes/mpSettlement.js';

describe('ledger upload validation', () => {
  it('normalizes a single-amount payment row into a credit with a stable identity', () => {
    const parsed = parseLedgerUploadRow({
      Date: '24/08/2026',
      Type: 'Payment',
      Amount: '₹1,250.50',
      Reference: 'NEFT-101',
      Description: 'Weekly payout',
    }, { marketplace: 'zepto', batch: 'batch-1' });

    expect(parsed.error).toBeUndefined();
    expect(parsed.values.slice(0, 8)).toEqual([
      'zepto', '2026-08-24', 'NEFT-101', '', 'Weekly payout', 'Payment', 0, 1250.5,
    ]);
    expect(parsed.fingerprint).toBe(ledgerSourceFingerprint({
      marketplace: 'zepto', entryDate: '2026-08-24', referenceNumber: 'NEFT-101',
      orderId: '', entryType: 'Payment', debit: 0, credit: 1250.5, description: 'Weekly payout',
    }));
  });

  it('rejects corrupt or ambiguous financial rows instead of coercing them', () => {
    const base = { Date: '2026-08-24', Type: 'Commission', Reference: 'REF-1' };

    expect(parseLedgerUploadRow({ ...base, Debit: '12oops' }, { marketplace: 'zepto', batch: 'b' }).error)
      .toContain('invalid debit');
    expect(parseLedgerUploadRow({ ...base, Debit: 50, Credit: 20 }, { marketplace: 'zepto', batch: 'b' }).error)
      .toContain('both debit and credit');
    expect(parseLedgerUploadRow({ ...base, Amount: 50 }, { marketplace: 'zepto', batch: 'b' }).values[6])
      .toBe(50);
    expect(parseLedgerUploadRow({ Date: '2026-08-24', Type: 'mystery', Amount: 50 }, { marketplace: 'zepto', batch: 'b' }).error)
      .toContain('invalid entry type');
  });
});
