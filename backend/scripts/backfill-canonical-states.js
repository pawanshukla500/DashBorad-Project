import dotenv from 'dotenv';
dotenv.config();
import { getPool } from '../db/index.js';
import { normalizeDeliveryState } from '../utils/geoNormalization.js';

export async function backfillCanonicalStates() {
  const pool = getPool();
  console.log('[backfillCanonicalStates] Starting state normalization backfill...');

  // 1. Backfill orders.delivery_state
  const orderStates = await pool.query(`
    SELECT DISTINCT delivery_state
    FROM orders
    WHERE delivery_state IS NOT NULL;
  `);

  console.log(`[backfillCanonicalStates] Found ${orderStates.rows.length} distinct delivery_state values in orders.`);
  let ordersUpdated = 0;

  for (const row of orderStates.rows) {
    const raw = row.delivery_state;
    const normalized = normalizeDeliveryState(raw);
    if (normalized !== raw) {
      const res = await pool.query(
        `UPDATE orders SET delivery_state = $1 WHERE delivery_state = $2`,
        [normalized, raw]
      );
      ordersUpdated += res.rowCount;
      console.log(`  Updated orders: '${raw}' -> '${normalized}' (${res.rowCount} rows)`);
    }
  }

  // Also clean up any '-' or 'CONFIDENTIAL' or 'null' values in orders
  const cleanedOrders = await pool.query(`
    UPDATE orders
    SET delivery_state = NULL
    WHERE delivery_state IN ('-', 'CONFIDENTIAL', 'null', 'undefined', 'None', 'NONE', 'na', 'NA', 'N/A')
  `);
  if (cleanedOrders.rowCount > 0) {
    console.log(`  Cleaned ${cleanedOrders.rowCount} invalid/placeholder delivery_state rows to NULL.`);
  }

  // 2. Backfill myntra_order_details.state
  const myntraStates = await pool.query(`
    SELECT DISTINCT state
    FROM myntra_order_details
    WHERE state IS NOT NULL;
  `);

  console.log(`[backfillCanonicalStates] Found ${myntraStates.rows.length} distinct state values in myntra_order_details.`);
  let myntraUpdated = 0;

  for (const row of myntraStates.rows) {
    const raw = row.state;
    const normalized = normalizeDeliveryState(raw);
    if (normalized !== raw) {
      const res = await pool.query(
        `UPDATE myntra_order_details SET state = $1 WHERE state = $2`,
        [normalized, raw]
      );
      myntraUpdated += res.rowCount;
      console.log(`  Updated myntra_order_details: '${raw}' -> '${normalized}' (${res.rowCount} rows)`);
    }
  }

  // 3. Backfill reconciliation_reports.delivery_state
  const recoStates = await pool.query(`
    SELECT DISTINCT delivery_state
    FROM reconciliation_reports
    WHERE delivery_state IS NOT NULL;
  `);

  let recoUpdated = 0;
  for (const row of recoStates.rows) {
    const raw = row.delivery_state;
    const normalized = normalizeDeliveryState(raw);
    if (normalized !== raw) {
      const res = await pool.query(
        `UPDATE reconciliation_reports SET delivery_state = $1 WHERE delivery_state = $2`,
        [normalized, raw]
      );
      recoUpdated += res.rowCount;
      console.log(`  Updated reconciliation_reports: '${raw}' -> '${normalized}' (${res.rowCount} rows)`);
    }
  }

  console.log(`[backfillCanonicalStates] Finished! Orders rows updated: ${ordersUpdated}, Myntra rows updated: ${myntraUpdated}, Reco rows: ${recoUpdated}`);
}

// Allow CLI execution
if (process.argv[1] && process.argv[1].endsWith('backfill-canonical-states.js')) {
  backfillCanonicalStates()
    .then(() => {
      console.log('[backfillCanonicalStates] Migration completed successfully.');
      process.exit(0);
    })
    .catch(err => {
      console.error('[backfillCanonicalStates] Migration failed:', err);
      process.exit(1);
    });
}
