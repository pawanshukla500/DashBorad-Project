import { describe, expect, it } from 'vitest';
import { calculateFees } from '../services/rateCard.js';

function rateCard(reverseShipping) {
  return {
    commission: [], fixedFee: [], collectionFee: [], pickAndPack: [], franchiseFee: [], reverseShipping,
  };
}

describe('reverse-shipping price bands', () => {
  it('selects the rate by order value, weight, and zone and includes it in return totals', () => {
    const rc = rateCard([
      { category: 'kurta', priceMin: 0, priceMax: 500, weightSlab: '0-0.5 kg', local: 80, zonal: 100, national: 120 },
      { category: 'kurta', priceMin: 501, priceMax: 999999, weightSlab: '0-0.5 kg', local: 130, zonal: 150, national: 170 },
      { category: 'kurta', priceMin: 0, priceMax: 999999, weightSlab: '0.5-1 kg', local: 160, zonal: 180, national: 200 },
    ]);

    const lowerBand = calculateFees(rc, { category: 'Kurta', price: 500, weight: 0.5, zone: 'zonal', isReturn: true });
    const higherBand = calculateFees(rc, { category: 'Kurta', price: 501, weight: 0.5, zone: 'national', isReturn: true });
    const heavier = calculateFees(rc, { category: 'Kurta', price: 200, weight: 0.8, zone: 'local', isReturn: true });

    expect(lowerBand.reverseShipping).toBe(100);
    expect(lowerBand.totalFees).toBe(100);
    expect(lowerBand.reverseShippingMeta).toMatchObject({ priceMin: 0, priceMax: 500, weightSlab: '0-0.5 kg' });
    expect(higherBand.reverseShipping).toBe(170);
    expect(heavier.reverseShipping).toBe(160);
  });

  it('keeps legacy reverse-shipping rows applicable to every price', () => {
    const rc = rateCard([
      { category: 'kurta', weightSlab: '0-500 gm', local: 82, zonal: 102, national: 122 },
    ]);
    const result = calculateFees(rc, { category: 'kurta', price: 9999, weight: 0.5, zone: 'local', isReturn: true });

    expect(result.reverseShipping).toBe(82);
    expect(result.totalFees).toBe(82);
  });
});
