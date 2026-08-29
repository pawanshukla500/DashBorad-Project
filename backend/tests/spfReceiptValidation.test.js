import { describe, expect, it } from 'vitest';
import { parseSpfReceiptInput } from '../routes/upload.js';

describe('SPF receipt input validation', () => {
  it('normalizes a valid receipt and retains an explicit zero amount', () => {
    expect(parseSpfReceiptInput({
      orderItemIds: ['item-1', 'item-1', 'item-2'], receivedDate: '24/08/2026',
      receivedAmount: '₹0', neftId: 'NEFT-1', claimId: 'CL-1',
    })).toEqual({
      orderItemIds: ['item-1', 'item-2'], receivedDate: '2026-08-24',
      receivedAmount: 0, neftId: 'NEFT-1', claimId: 'CL-1',
    });
  });

  it('rejects unsafe IDs, malformed amounts, and invalid dates', () => {
    expect(() => parseSpfReceiptInput({ orderItemIds: [''], receivedAmount: 10 }))
      .toThrow('orderItemIds[0] is required');
    expect(() => parseSpfReceiptInput({ orderItemIds: ['item-1'], receivedAmount: '10oops' }))
      .toThrow('receivedAmount must be a non-negative number');
    expect(() => parseSpfReceiptInput({ orderItemIds: ['item-1'], receivedDate: '31/02/2026' }))
      .toThrow('receivedDate must be a valid date');
  });
});
