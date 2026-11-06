import { describe, it, expect, vi } from 'vitest';
import {
  validateExtractionCompleteness,
  compareWithPreviousExtraction,
  detectExtractionAnomalies,
  compileDailyValidationReport,
  ANOMALY_THRESHOLDS,
  dayBefore,
  getLastValidatedExtraction,
  saveRateCardExtraction
} from '../services/rateCardDailyValidation.js';
import { sendAdminRateCardAlert } from '../services/rateCardNotifications.js';

function createMockRateCard(overrides = {}) {
  return {
    marketplace: 'flipkart',
    category: 'kurta',
    brand: 'Youthnic',
    effectiveDate: '2026-11-06',
    commissions: [
      { price_min: 0, price_max: 500, rate: 0.12 }
    ],
    fixedFees: [
      { fulfilment_type: 'FBF', price_min: 0, price_max: 500, rate: 15.0 }
    ],
    reverseShipping: [
      { weight_slab: '0-0.5kg', price_min: 0, price_max: 500, local_fee: 20.0, zonal_fee: 30.0, national_fee: 40.0 }
    ],
    collectionFees: [
      { fulfilment_type: 'All', price_min: 0, price_max: 500, prepaid: 0.02, postpaid: 0.02, prepaid_type: 'PERCENT', postpaid_type: 'PERCENT' }
    ],
    pickPackFees: [
      { fulfilment_type: 'FBF', weight_min: 0, weight_max: 0.5, price_min: 0, price_max: 500, rate: 15.0 }
    ],
    ...overrides
  };
}

describe('Rate Card Daily Validation & Anomaly Detection Workflow', () => {

  // Scenario 1: No fee changes detected
  it('Scenario 1: recognizes when no fee changes are detected and marks report clean', () => {
    const card = createMockRateCard();
    const prevExtractionRecord = {
      extraction_date: '2026-11-05',
      rate_cards: [card]
    };

    const report = compileDailyValidationReport({
      currentCards: [card],
      previousExtractionRecord: prevExtractionRecord,
      activeDbChanges: [],
      options: { currentDate: '2026-11-06', effectiveDate: '2026-11-06', marketplace: 'flipkart' }
    });

    expect(report.completeness.valid).toBe(true);
    expect(report.validationStatus).toBe('no_changes');
    expect(report.requiresAdminApproval).toBe(false);
    expect(report.autoUpdatable).toBe(false); // No changes to update
    expect(report.anomalies).toHaveLength(0);
    expect(report.vsPreviousExtraction.hasChanges).toBe(false);
    expect(report.vsPreviousExtraction.unchangedParametersCount).toBeGreaterThan(0);
  });

  // Scenario 2: Single fee parameter changes
  it('Scenario 2: detects a single parameter change and flags anomaly when threshold exceeded', () => {
    const baseCard = createMockRateCard();
    const modifiedCard = createMockRateCard({
      reverseShipping: [
        { weight_slab: '0-0.5kg', price_min: 0, price_max: 500, local_fee: 20.0, zonal_fee: 60.0, national_fee: 40.0 }
      ]
    });
    const prevExtractionRecord = {
      extraction_date: '2026-11-05',
      rate_cards: [baseCard]
    };

    const activeDbChanges = [
      {
        type: 'reverse_shipping',
        category: 'kurta',
        oldFees: { local: 20, zonal: 30, national: 40 },
        newFees: { local: 20, zonal: 60, national: 40 },
        difference: '+₹30.00'
      }
    ];

    const report = compileDailyValidationReport({
      currentCards: [modifiedCard],
      previousExtractionRecord: prevExtractionRecord,
      activeDbChanges,
      options: { currentDate: '2026-11-06', effectiveDate: '2026-11-06', marketplace: 'flipkart' }
    });

    expect(report.completeness.valid).toBe(true);
    expect(report.validationStatus).toBe('anomalies_detected');
    expect(report.requiresAdminApproval).toBe(true);
    expect(report.anomalies.length).toBeGreaterThanOrEqual(1);
    expect(report.anomalies[0].type).toBe('reverse_shipping_anomaly');
    expect(report.vsPreviousExtraction.modifiedParameters).toHaveLength(1);
  });

  // Scenario 3: Multiple fee parameters change together
  it('Scenario 3: detects multiple fee parameters changing simultaneously', () => {
    const baseCard = createMockRateCard();
    const multiChangedCard = createMockRateCard({
      commissions: [{ price_min: 0, price_max: 500, rate: 0.20 }], // +8pp (anomaly > 5pp)
      fixedFees: [{ fulfilment_type: 'FBF', price_min: 0, price_max: 500, rate: 45.0 }] // +₹30 (anomaly > ₹20)
    });
    const prevExtractionRecord = {
      extraction_date: '2026-11-05',
      rate_cards: [baseCard]
    };

    const activeDbChanges = [
      { type: 'commission', category: 'kurta', oldRate: 0.12, newRate: 0.20 },
      { type: 'fixed_fee', category: 'kurta', oldRate: 15.0, newRate: 45.0 }
    ];

    const report = compileDailyValidationReport({
      currentCards: [multiChangedCard],
      previousExtractionRecord: prevExtractionRecord,
      activeDbChanges,
      options: { currentDate: '2026-11-06', effectiveDate: '2026-11-06', marketplace: 'flipkart' }
    });

    expect(report.validationStatus).toBe('anomalies_detected');
    expect(report.anomalies.length).toBe(2);
    expect(report.anomalies.some(a => a.type === 'commission_anomaly')).toBe(true);
    expect(report.anomalies.some(a => a.type === 'fixed_fee_anomaly')).toBe(true);
    expect(report.summary.modifiedParametersCount).toBe(2);
  });

  // Scenario 4: A completely new fee parameter appears
  it('Scenario 4: detects newly introduced fee parameter/slab', () => {
    const baseCard = createMockRateCard();
    const newSlabCard = createMockRateCard({
      commissions: [
        { price_min: 0, price_max: 500, rate: 0.12 },
        { price_min: 501, price_max: 1000, rate: 0.15 } // Newly introduced slab
      ]
    });
    const prevExtractionRecord = {
      extraction_date: '2026-11-05',
      rate_cards: [baseCard]
    };

    const vsPrevious = compareWithPreviousExtraction([newSlabCard], prevExtractionRecord);
    expect(vsPrevious.newParameters).toHaveLength(1);
    expect(vsPrevious.newParameters[0].changeType).toBe('ADDED');
    expect(vsPrevious.newParameters[0].slab).toContain('₹501-₹1000');
  });

  // Scenario 5: An existing fee parameter disappears
  it('Scenario 5: detects removed parameter and flags missing parameter anomaly', () => {
    const baseCard = createMockRateCard({
      commissions: [
        { price_min: 0, price_max: 500, rate: 0.12 },
        { price_min: 501, price_max: 1000, rate: 0.15 }
      ]
    });
    const reducedCard = createMockRateCard({
      commissions: [
        { price_min: 0, price_max: 500, rate: 0.12 }
        // 501-1000 disappeared!
      ]
    });
    const prevExtractionRecord = {
      extraction_date: '2026-11-05',
      rate_cards: [baseCard]
    };

    const report = compileDailyValidationReport({
      currentCards: [reducedCard],
      previousExtractionRecord: prevExtractionRecord,
      activeDbChanges: [],
      options: { currentDate: '2026-11-06', effectiveDate: '2026-11-06', marketplace: 'flipkart' }
    });

    expect(report.summary.missingParametersCount).toBe(1);
    expect(report.anomalies.some(a => a.type === 'missing_parameters_anomaly')).toBe(true);
    expect(report.requiresAdminApproval).toBe(true);
  });

  // Scenario 6: Extraction fails or returns incomplete data
  it('Scenario 6: flags incomplete or corrupt extraction data fail-closed', () => {
    // 6a: empty payload
    const emptyResult = validateExtractionCompleteness([]);
    expect(emptyResult.valid).toBe(false);
    expect(emptyResult.errors[0]).toContain('empty');

    // 6b: invalid rates and inverted slabs
    const corruptCard = createMockRateCard({
      category: '', // missing category
      commissions: [
        { price_min: 1000, price_max: 500, rate: -0.05 } // inverted and negative
      ]
    });
    const corruptResult = validateExtractionCompleteness([corruptCard]);
    expect(corruptResult.valid).toBe(false);
    expect(corruptResult.errors.length).toBeGreaterThanOrEqual(2);

    // 6c: Shopsy 0% commission invariant
    const shopsyViolator = createMockRateCard({
      marketplace: 'shopsy',
      commissions: [{ price_min: 0, price_max: 500, rate: 0.05 }]
    });
    const shopsyResult = validateExtractionCompleteness([shopsyViolator]);
    expect(shopsyResult.valid).toBe(false);
    expect(shopsyResult.errors.some(e => e.includes('Shopsy rate invariant violation'))).toBe(true);
  });

  // Scenario 7: Extraction is skipped for one or more days (multi-day gap)
  it('Scenario 7: bridges multi-day extraction gaps and lists all skipped days', () => {
    const card = createMockRateCard();
    const prevExtractionRecord = {
      extraction_date: '2026-11-01',
      rate_cards: [card]
    };

    // New extraction happens on 4 November (2 Nov and 3 Nov were skipped)
    const vsPrevious = compareWithPreviousExtraction([card], prevExtractionRecord, {
      currentDate: '2026-11-04'
    });

    expect(vsPrevious.hasPreviousExtraction).toBe(true);
    expect(vsPrevious.daysElapsed).toBe(3);
    expect(vsPrevious.skippedDays).toEqual(['2026-11-02', '2026-11-03']);
    expect(vsPrevious.gapText).toContain('2 extraction day(s) skipped');
  });

  // Scenario 8: Duplicate extraction occurs on the same day
  it('Scenario 8: handles duplicate extraction on same calendar day cleanly', () => {
    const card = createMockRateCard();
    const prevExtractionRecord = {
      extraction_date: '2026-11-06',
      rate_cards: [card]
    };

    const vsPrevious = compareWithPreviousExtraction([card], prevExtractionRecord, {
      currentDate: '2026-11-06'
    });

    expect(vsPrevious.daysElapsed).toBe(0);
    expect(vsPrevious.skippedDays).toEqual([]);
    expect(vsPrevious.hasChanges).toBe(false);
  });

  // Scenario 9: The new rate card has a future effective date
  it('Scenario 9: detects future effective date and requires admin approval before auto-publishing', () => {
    const card = createMockRateCard();
    const prevExtractionRecord = {
      extraction_date: '2026-11-05',
      rate_cards: [card]
    };

    const report = compileDailyValidationReport({
      currentCards: [card],
      previousExtractionRecord: prevExtractionRecord,
      activeDbChanges: [],
      options: {
        currentDate: '2026-11-06',
        effectiveDate: '2026-12-01', // Future effective date!
        marketplace: 'flipkart'
      }
    });

    expect(report.anomalies.some(a => a.type === 'future_effective_date')).toBe(true);
    expect(report.requiresAdminApproval).toBe(true);
    expect(report.autoUpdatable).toBe(false);
  });

  // Scenario 10: Email or WhatsApp notification delivery resilience
  it('Scenario 10: handles notification failures with full error containment and audit logging', async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [{ id: 123, status: 'failed' }]
    });
    const mockPool = { query: mockQuery };

    // Trigger alert without live Resend or WhatsApp API keys configured
    const alertResult = await sendAdminRateCardAlert(mockPool, {
      marketplace: 'flipkart',
      sellerAccount: 'default',
      extractionDate: '2026-11-06',
      effectiveDate: '2026-11-06',
      validationStatus: 'anomalies_detected',
      anomalies: [{ type: 'commission_anomaly', reason: 'Commission shift >=5pp' }],
      changes: [{ type: 'commission', category: 'kurta', difference: '+5.00 pp' }],
      autoApplied: false,
      requiresApproval: true
    });

    // Alert execution should not throw!
    expect(alertResult).toBeDefined();
    expect(alertResult.email).toBeDefined();
    expect(alertResult.whatsapp).toBeDefined();
    // Notification log audit insert should have executed
    expect(mockQuery).toHaveBeenCalled();
    const sqlCalls = mockQuery.mock.calls.map(([sql]) => sql);
    expect(sqlCalls.some(sql => sql.includes('rate_card_notification_log'))).toBe(true);
  });

  // Database snapshot retrieval & persistence
  it('persists and retrieves daily extraction records from PostgreSQL', async () => {
    const mockRecord = {
      marketplace: 'flipkart',
      sellerAccount: 'default',
      extractionDate: '2026-11-06',
      status: 'validated',
      rateCards: [createMockRateCard()],
      parametersSummary: { totalCards: 1 }
    };

    const mockQuery = vi.fn().mockImplementation(async (sql, params) => {
      if (sql.includes('INSERT INTO rate_card_extractions')) {
        return { rows: [{ id: 1, extraction_date: params[2], status: params[3] }] };
      }
      if (sql.includes('SELECT') && sql.includes('FROM rate_card_extractions')) {
        return { rows: [{ id: 1, extraction_date: '2026-11-06', status: 'validated', rate_cards: mockRecord.rateCards }] };
      }
      return { rows: [] };
    });
    const mockPool = { query: mockQuery };

    const saved = await saveRateCardExtraction(mockPool, mockRecord);
    expect(saved).toBeDefined();
    expect(saved.id).toBe(1);

    const fetched = await getLastValidatedExtraction(mockPool, { marketplace: 'flipkart', sellerAccount: 'default' });
    expect(fetched).toBeDefined();
    expect(fetched.extraction_date).toBe('2026-11-06');
  });

  // Day before date helper
  it('calculates the exact day before an ISO date contiguous period closure', () => {
    expect(dayBefore('2026-11-01')).toBe('2026-10-31');
    expect(dayBefore('2026-03-01')).toBe('2026-02-28');
    expect(dayBefore('2024-03-01')).toBe('2024-02-29'); // Leap year
  });
});
