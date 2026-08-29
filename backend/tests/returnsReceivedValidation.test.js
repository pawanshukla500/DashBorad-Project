import { describe, expect, it } from 'vitest';
import { parseReturnsReceivedRow } from '../routes/upload.js';

describe('returns-received tracker validation', () => {
  it('recognizes the exact headers used by the generated return tracker template', () => {
    expect(parseReturnsReceivedRow({
      order_item_id: 'OI-100', return_received_yes_no: 'Yes',
      condition_good_bad: 'Bad', received_date: '24/08/2026', notes: 'Torn seam',
    })).toEqual({
      orderItemId: 'OI-100', received: true, isBad: true,
      receivedDate: '2026-08-24', notes: 'Torn seam',
    });
  });

  it('requires an explicit, internally consistent receipt state', () => {
    expect(() => parseReturnsReceivedRow({ order_item_id: 'OI-100' }))
      .toThrow('Return Received? is required');
    expect(() => parseReturnsReceivedRow({
      order_item_id: 'OI-100', return_received_yes_no: 'Yes', condition_good_bad: 'Good', received_date: '31/02/2026',
    })).toThrow('Received Date must be a valid date');
    expect(() => parseReturnsReceivedRow({
      order_item_id: 'OI-100', return_received_yes_no: 'No', condition_good_bad: 'Bad',
    })).toThrow('Condition and Received Date must be blank');
    expect(parseReturnsReceivedRow({ order_item_id: 'OI-100', return_received_yes_no: 'No' }))
      .toMatchObject({ received: false, isBad: null, receivedDate: null });
  });
});
