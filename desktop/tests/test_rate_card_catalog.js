import assert from 'node:assert/strict';
import { getRealTimeBrandFsnSamples } from '../rateCardService.js';

const calls = [];
const pool = {
  async query(sql) {
    calls.push(String(sql));
    return { rows: [{
      marketplace: 'flipkart', category: 'kurta', brand: 'Youthnic', seller_account: 'default',
      sample_fsn: 'ABCDEFGHIJKLMNOP', sample_sku: 'SKU-1', order_count: 3,
    }] };
  },
};

const catalog = await getRealTimeBrandFsnSamples(pool);
assert.equal(catalog.length, 1);
assert.equal(catalog[0].sample_fsn, 'ABCDEFGHIJKLMNOP');
assert.match(calls[0], /UPPER\(TRIM\(fsn\)\) as fsn/i);
assert.match(calls[0], /UPPER\(TRIM\(fsn\)\) ~ '\^\[A-Z0-9\]\{16\}\$'/i,
  'invalid or blank FSNs are excluded before choosing a sample for a category');
assert.match(calls[0], /TRIM\(category\) != ''/i);

console.log('✓ Desktop worker catalog requires a real 16-character database FSN.');
