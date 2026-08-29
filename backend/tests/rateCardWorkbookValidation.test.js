import { describe, expect, it } from 'vitest';
import { buildRateCardTables } from '../services/rateCard.js';

describe('legacy rate-card workbook validation', () => {
  it('normalizes valid percentage rates without changing a real zero fee', () => {
    const tables = buildRateCardTables({
      commission: [['Kurta', '01/08/2026', '31/08/2026', '₹100', '₹999', '12%']],
      fixedFee: [['Kurta', '', '', 'Non-FBF', 0, 999, 0]],
      reverseShipping: [['Kurta', '', '', '0-500 gm', 0, 12, 20]],
      collectionFee: [['Kurta', '', '', 0, 999, '1%', '0.5%']],
      pickAndPack: [['Kurta', '', '', 0, 999, 8]],
    });

    expect(tables.commission[0]).toMatchObject({
      category: 'kurta', startDate: '2026-08-01', endDate: '2026-08-31', rate: 0.12,
    });
    expect(tables.fixedFee[0].rate).toBe(0);
    expect(tables.reverseShipping[0].weightSlab).toBe('0-500 gm');
  });

  it('rejects malformed values before a workbook can replace an active card', () => {
    expect(() => buildRateCardTables({
      commission: [['Kurta', '', '', 0, 999, '12oops']],
    })).toThrow('commission rate must be a non-negative number');

    expect(() => buildRateCardTables({
      reverseShipping: [['Kurta', '', '', '1oops', 10, 20, 30]],
    })).toThrow('weight slab must be a positive number');
  });
});
