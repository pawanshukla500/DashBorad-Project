import assert from 'assert';
import {
  validateExtractionCompleteness,
  compareWithPreviousExtraction,
  detectExtractionAnomalies,
  compileDailyValidationReport,
  dayBefore
} from '../rateCardDailyValidation.js';

console.log('=================================================================');
console.log(' Desktop Rate Card Daily Validation & Dual Anomaly Regression Test');
console.log('=================================================================\n');

function card(overrides = {}) {
  return {
    marketplace: 'flipkart',
    category: 'kurta',
    brand: 'Youthnic',
    effectiveDate: '2026-11-06',
    commissions: [{ price_min: 0, price_max: 500, rate: 0.12 }],
    fixedFees: [{ fulfilment_type: 'FBF', price_min: 0, price_max: 500, rate: 15.0 }],
    reverseShipping: [{ weight_slab: '0-0.5kg', price_min: 0, price_max: 500, local_fee: 20.0, zonal_fee: 30.0, national_fee: 40.0 }],
    collectionFees: [{ fulfilment_type: 'All', price_min: 0, price_max: 500, prepaid: 0.02, postpaid: 0.02, prepaid_type: 'PERCENT', postpaid_type: 'PERCENT' }],
    pickPackFees: [{ fulfilment_type: 'FBF', weight_min: 0, weight_max: 0.5, price_min: 0, price_max: 500, rate: 15.0 }],
    ...overrides
  };
}

// 1. Completeness validation
const complete = validateExtractionCompleteness([card()]);
assert.strictEqual(complete.valid, true, 'Valid card should pass completeness checks');
console.log('[Test] validateExtractionCompleteness accepts valid payload ... ✓ PASS');

const incomplete = validateExtractionCompleteness([]);
assert.strictEqual(incomplete.valid, false, 'Empty payload must fail closed');
console.log('[Test] validateExtractionCompleteness rejects empty payload ... ✓ PASS');

// 2. Shopsy 0% invariant
const shopsyViolation = validateExtractionCompleteness([card({ marketplace: 'shopsy', commissions: [{ price_min: 0, price_max: 500, rate: 0.05 }] })]);
assert.strictEqual(shopsyViolation.valid, false);
assert(shopsyViolation.errors[0].includes('Shopsy rate invariant violation'));
console.log('[Test] validateExtractionCompleteness enforces Shopsy 0% commission invariant ... ✓ PASS');

// 3. Multi-day gap detection
const multiDayVs = compareWithPreviousExtraction([card()], { extraction_date: '2026-11-01', rate_cards: [card()] }, { currentDate: '2026-11-04' });
assert.strictEqual(multiDayVs.daysElapsed, 3);
assert.deepStrictEqual(multiDayVs.skippedDays, ['2026-11-02', '2026-11-03']);
console.log('[Test] compareWithPreviousExtraction detects and lists multi-day gaps ... ✓ PASS');

// 4. Anomaly detection on rate jumps
const anomalyReport = compileDailyValidationReport({
  currentCards: [card({ commissions: [{ price_min: 0, price_max: 500, rate: 0.20 }] })],
  previousExtractionRecord: { extraction_date: '2026-11-05', rate_cards: [card()] },
  activeDbChanges: [{ type: 'commission', category: 'kurta', oldRate: 0.12, newRate: 0.20 }],
  options: { currentDate: '2026-11-06', effectiveDate: '2026-11-06', marketplace: 'flipkart' }
});
assert.strictEqual(anomalyReport.validationStatus, 'anomalies_detected');
assert.strictEqual(anomalyReport.requiresAdminApproval, true);
assert(anomalyReport.anomalies.some(a => a.type === 'commission_anomaly'));
console.log('[Test] compileDailyValidationReport flags commission jump anomaly and requires admin approval ... ✓ PASS');

// 5. Future effective date
const futureReport = compileDailyValidationReport({
  currentCards: [card()],
  previousExtractionRecord: { extraction_date: '2026-11-05', rate_cards: [card()] },
  activeDbChanges: [],
  options: { currentDate: '2026-11-06', effectiveDate: '2026-12-01', marketplace: 'flipkart' }
});
assert(futureReport.anomalies.some(a => a.type === 'future_effective_date'));
assert.strictEqual(futureReport.requiresAdminApproval, true);
console.log('[Test] compileDailyValidationReport flags future effective date for scheduling verification ... ✓ PASS');

// 6. Day before helper
assert.strictEqual(dayBefore('2026-11-01'), '2026-10-31');
assert.strictEqual(dayBefore('2026-03-01'), '2026-02-28');
assert.strictEqual(dayBefore('2024-03-01'), '2024-02-29');
console.log('[Test] dayBefore handles months and leap years accurately ... ✓ PASS');

console.log('\nAll 6 Desktop Daily Validation Regression Tests Passed!\n');
