import { describe, it, expect, vi, beforeEach } from 'vitest';
import { compareScrapedRatesWithActive } from '../services/rateCardCanonicalEngine.js';
import { publishRateCardObservations } from '../services/rateCardPublisher.js';

describe('Rate Card Canonical Change Detection Engine', () => {
  it('returns hasChanges = false and diffCount = 0 when scraped rates are numerically identical to active rates', async () => {
    const mockDb = {
      query: vi.fn().mockImplementation((sql, params) => {
        if (sql.includes('rc_commission')) {
          return Promise.resolve({
            rows: [
              { id: '1', category: 'kurta', brand_name: '', price_min: '0.00', price_max: '1500.00', rate: '0.1200' }
            ]
          });
        }
        if (sql.includes('rc_fixed_fee')) {
          return Promise.resolve({
            rows: [
              { id: '2', category: 'kurta', fulfilment_type: 'Bronze', price_min: '0.00', price_max: '1500.00', rate: '10.00' }
            ]
          });
        }
        return Promise.resolve({ rows: [] });
      })
    };

    const observations = [
      {
        vertical: 'kurta',
        commissions: [
          { brand_name: '', price_min: 0, price_max: 1500, rate: 0.12 }
        ],
        fixedFees: [
          { fulfilment_type: 'Bronze', price_min: 0, price_max: 1500, rate: 10 }
        ]
      }
    ];

    const result = await compareScrapedRatesWithActive(observations, {
      marketplace: 'flipkart',
      sellerAccount: 'default',
      dbClient: mockDb
    });

    expect(result.hasChanges).toBe(false);
    expect(result.diffCount).toBe(0);
    expect(result.diffs.length).toBe(0);
    expect(result.summary.unchanged).toBe(2);
    expect(result.summary.modified).toBe(0);
    expect(result.summary.added).toBe(0);
  });

  it('detects genuine rate modifications and flags anomalies when rate changes by >= 50%', async () => {
    const mockDb = {
      query: vi.fn().mockImplementation((sql) => {
        if (sql.includes('rc_commission')) {
          return Promise.resolve({
            rows: [
              { id: '1', category: 'kurta', brand_name: '', price_min: '0.00', price_max: '1500.00', rate: '0.1000' }
            ]
          });
        }
        return Promise.resolve({ rows: [] });
      })
    };

    const observations = [
      {
        vertical: 'kurta',
        commissions: [
          // Rate jump from 10% to 20% (100% increase -> anomaly)
          { brand_name: '', price_min: 0, price_max: 1500, rate: 0.20 }
        ]
      }
    ];

    const result = await compareScrapedRatesWithActive(observations, {
      marketplace: 'flipkart',
      sellerAccount: 'default',
      dbClient: mockDb
    });

    expect(result.hasChanges).toBe(true);
    expect(result.diffCount).toBe(1);
    expect(result.diffs[0].changeType).toBe('MODIFIED');
    expect(result.diffs[0].oldRate).toBe(0.10);
    expect(result.diffs[0].newRate).toBe(0.20);
    expect(result.diffs[0].anomaly).toBe(true);
    expect(result.summary.anomalies).toBe(1);
  });

  it('detects newly added price slabs', async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({ rows: [] })
    };

    const observations = [
      {
        vertical: 'gown',
        commissions: [
          { brand_name: '', price_min: 1501, price_max: 999999, rate: 0.18 }
        ]
      }
    ];

    const result = await compareScrapedRatesWithActive(observations, {
      marketplace: 'flipkart',
      sellerAccount: 'default',
      dbClient: mockDb
    });

    expect(result.hasChanges).toBe(true);
    expect(result.diffCount).toBe(1);
    expect(result.diffs[0].changeType).toBe('ADDED');
    expect(result.diffs[0].newRate).toBe(0.18);
  });

  it('detects removed commission slabs when active DB slab is missing in scrape', async () => {
    const mockDb = {
      query: vi.fn().mockImplementation((sql) => {
        if (sql.includes('rc_commission')) {
          return Promise.resolve({
            rows: [
              { id: '1', category: 'kurta', brand_name: '', price_min: '0.00', price_max: '500.00', rate: '0.1000' },
              { id: '2', category: 'kurta', brand_name: '', price_min: '501.00', price_max: '1500.00', rate: '0.1200' }
            ]
          });
        }
        return Promise.resolve({ rows: [] });
      })
    };

    // Scrape only has 0-500, 501-1500 was removed
    const observations = [
      {
        vertical: 'kurta',
        commissions: [
          { brand_name: '', price_min: 0, price_max: 500, rate: 0.10 }
        ]
      }
    ];

    const result = await compareScrapedRatesWithActive(observations, {
      marketplace: 'flipkart',
      sellerAccount: 'default',
      dbClient: mockDb
    });

    expect(result.hasChanges).toBe(true);
    const removedDiff = result.diffs.find(d => d.changeType === 'REMOVED');
    expect(removedDiff).toBeDefined();
    expect(removedDiff.slab).toBe('₹501 - ₹1500');
    expect(removedDiff.oldRate).toBe(0.12);
  });

  it('protects brand-specific commission rates from being falsely marked removed by generic portal scrapes', async () => {
    const mockDb = {
      query: vi.fn().mockImplementation((sql) => {
        if (sql.includes('rc_commission')) {
          return Promise.resolve({
            rows: [
              { id: '1', category: 'kurta', brand_name: '', price_min: '0.00', price_max: '1500.00', rate: '0.1200' },
              { id: '2', category: 'kurta', brand_name: 'Ethnic Junction', price_min: '0.00', price_max: '1500.00', rate: '0.0900' }
            ]
          });
        }
        return Promise.resolve({ rows: [] });
      })
    };

    // Generic scrape with brand_name: '' or undefined
    const observations = [
      {
        vertical: 'kurta',
        commissions: [
          { brand_name: '', price_min: 0, price_max: 1500, rate: 0.12 }
        ]
      }
    ];

    const result = await compareScrapedRatesWithActive(observations, {
      marketplace: 'flipkart',
      sellerAccount: 'default',
      dbClient: mockDb
    });

    // The generic rule matches id: 1. id: 2 (Ethnic Junction) is NOT marked removed!
    expect(result.hasChanges).toBe(false);
    expect(result.diffCount).toBe(0);
    expect(result.summary.unchanged).toBe(1);
    expect(result.diffs.filter(d => d.changeType === 'REMOVED').length).toBe(0);
  });
});

