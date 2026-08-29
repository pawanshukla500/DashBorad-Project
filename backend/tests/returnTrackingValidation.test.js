import { describe, expect, it } from 'vitest';
import { parseReturnTrackingRow } from '../routes/returnTracking.js';

describe('return tracking validation', () => {
  it('canonicalizes supported tracking values before a database write', () => {
    const parsed = parseReturnTrackingRow({
      orderItemId: 'OI-1001',
      marketplace: 'FlipKart',
      physicalCondition: 'not_received',
      spfStatus: 'not applicable',
      remarks: '  Packaging damaged  ',
    });

    expect(parsed.error).toBeUndefined();
    expect(parsed.values).toEqual([
      'OI-1001', 'flipkart', 'Not Received', 'Not Applicable', 'Packaging damaged',
    ]);
  });

  it('rejects unknown statuses and empty mutations', () => {
    expect(parseReturnTrackingRow({
      orderItemId: 'OI-1001', marketplace: 'flipkart', physicalCondition: 'Maybe',
    }).error).toContain('invalid physical condition');
    expect(parseReturnTrackingRow({
      orderItemId: 'OI-1001', marketplace: 'flipkart', spfStatus: 'Escalated',
    }).error).toContain('invalid SPF status');
    expect(parseReturnTrackingRow({
      orderItemId: 'OI-1001', marketplace: 'flipkart',
    }).error).toContain('provide a physical condition');
  });
});
