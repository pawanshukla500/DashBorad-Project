import { describe, it, expect, vi } from 'vitest';
import { attachRcFees } from '../services/orderFeeService.js';
import * as rateCardService from '../services/rateCard.js';

// Mock the dependencies
vi.mock('../services/rateCard.js', () => ({
  getRateCard: vi.fn(),
  calculateFees: vi.fn()
}));

describe('orderFeeService - attachRcFees', () => {
  it('should return empty array when no orders are provided', async () => {
    const result = await attachRcFees([]);
    expect(result).toEqual([]);
  });

  it('should calculate fees correctly for an order', async () => {
    // Mock getRateCard to return a dummy rate card
    rateCardService.getRateCard.mockResolvedValue({ id: 'dummy_rc' });
    
    // Mock calculateFees to return some standard fees
    rateCardService.calculateFees.mockReturnValue({
      commission: 10,
      fixedFee: 5,
      collectionFee: 2,
      pickPack: 1,
      gstOnFees: 3.24,
      totalFees: 21.24,
      price: 100,
      netToSeller: 78.76,
      commissionRate: 10
    });

    const orders = [
      {
        id: 1,
        marketplace: 'flipkart',
        sellerAccount: 'test_account',
        finalInvoiceAmount: '100',
        cogs: '50'
      }
    ];

    const result = await attachRcFees(orders);

    expect(result).toHaveLength(1);
    expect(result[0].rcTotalFees).toBe(21.24);
    
    // Profit = price - rcTotalFees - cogs = 100 - 21.24 - 50 = 28.76
    expect(result[0].rcProfit).toBe(28.76);
    
    // Margin Pct = (28.76 / 100) * 100 = 28.76
    expect(result[0].rcMarginPct).toBe(28.76);
    
    expect(rateCardService.getRateCard).toHaveBeenCalledWith('flipkart', 'test_account');
    expect(rateCardService.calculateFees).toHaveBeenCalled();
  });

  it('should handle orders where rate card is missing', async () => {
    rateCardService.getRateCard.mockResolvedValue(null);

    const orders = [
      { id: 2, marketplace: 'amazon', sellerAccount: 'unknown' }
    ];

    const result = await attachRcFees(orders);

    expect(result).toHaveLength(1);
    expect(result[0].rcFees).toBeNull();
    // It shouldn't have other rc properties attached if rc is missing
    expect(result[0].rcTotalFees).toBeUndefined();
  });
});
