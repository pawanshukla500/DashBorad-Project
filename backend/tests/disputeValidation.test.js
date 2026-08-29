import { describe, expect, it } from 'vitest';
import { parseDisputeInput } from '../routes/disputes.js';

describe('fee dispute validation', () => {
  it('normalizes allowed workflow status and strict currency values', () => {
    expect(parseDisputeInput({
      order_item_id: 'OI-1001',
      fee_type: 'commission',
      dispute_status: 'In Review',
      expected_amount: '₹120.50',
      actual_amount: '130.00',
    }).values).toEqual(['OI-1001', 'commission', 120.5, 130, 'in_review']);
  });

  it('rejects corrupt financial values and unsupported workflow states', () => {
    expect(() => parseDisputeInput({
      order_item_id: 'OI-1001', fee_type: 'commission', dispute_status: 'escalated',
    })).toThrow('invalid dispute_status');
    expect(() => parseDisputeInput({
      order_item_id: 'OI-1001', fee_type: 'commission', dispute_status: 'open', expected_amount: '12oops',
    })).toThrow('invalid expected_amount');
  });
});
