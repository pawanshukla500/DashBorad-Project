/**
 * Rate Card Change Detection & Database Sync Engine
 * 
 * Compares freshly scraped rate cards with active DB rates.
 * If changes are detected:
 *   1. Auto-closes previous rate periods (end_date = dayBefore(new_start_date)).
 *   2. Inserts new active rate cards (start_date = new_start_date, end_date = NULL).
 *   3. Publishes an immutable snapshot in rate_card_versions.
 *   4. Invalidates rate card caches across ReconCentral.
 *   5. Sends alert notifications via Resend.
 */
import { getPool } from '../db/index.js';
import { clearRateCardCache } from './rateCard.js';
import { dayBefore } from '../routes/rateCard.js';

/**
 * Compare scraped rates with existing active rates in DB
 */
export async function detectRateChanges(scrapedList, marketplace = 'flipkart', sellerAccount = 'default') {
  const pool = getPool();
  const changes = [];

  for (const scraped of scrapedList) {
    const { vertical, effectiveDate, commissions, fixedFees, collectionFees, reverseShipping } = scraped;

    // 1. Check Commission Changes
    const activeCommissions = await pool.query(`
      SELECT price_min, price_max, rate 
      FROM rc_commission 
      WHERE marketplace = $1 AND seller_account = $2 AND category = $3 AND end_date IS NULL
    `, [marketplace, sellerAccount, vertical]);

    for (const sc of commissions) {
      const match = activeCommissions.rows.find(ac => 
        Math.abs(parseFloat(ac.price_min) - sc.price_min) < 0.01 &&
        Math.abs(parseFloat(ac.price_max) - sc.price_max) < 1.0
      );
      if (!match) {
        changes.push({
          type: 'commission',
          category: vertical,
          slab: `₹${sc.price_min} - ₹${sc.price_max}`,
          oldRate: null,
          newRate: sc.rate,
          reason: 'New commission price slab'
        });
      } else if (Math.abs(parseFloat(match.rate) - sc.rate) > 0.0001) {
        changes.push({
          type: 'commission',
          category: vertical,
          slab: `₹${sc.price_min} - ₹${sc.price_max}`,
          oldRate: parseFloat(match.rate),
          newRate: sc.rate,
          reason: 'Commission rate percentage changed'
        });
      }
    }

    // 2. Check Fixed Fee Changes
    const activeFixedFees = await pool.query(`
      SELECT fulfilment_type, price_min, price_max, rate 
      FROM rc_fixed_fee 
      WHERE marketplace = $1 AND seller_account = $2 AND category = $3 AND end_date IS NULL
    `, [marketplace, sellerAccount, vertical]);

    for (const sf of fixedFees) {
      const match = activeFixedFees.rows.find(af =>
        af.fulfilment_type === sf.fulfilment_type &&
        Math.abs(parseFloat(af.price_min) - sf.price_min) < 0.01 &&
        Math.abs(parseFloat(af.price_max) - sf.price_max) < 1.0
      );
      if (!match) {
        changes.push({
          type: 'fixed_fee',
          category: vertical,
          slab: `${sf.fulfilment_type}: ₹${sf.price_min} - ₹${sf.price_max}`,
          oldRate: null,
          newRate: sf.rate,
          reason: 'New fixed fee slab or tier'
        });
      } else if (Math.abs(parseFloat(match.rate) - sf.rate) > 0.01) {
        changes.push({
          type: 'fixed_fee',
          category: vertical,
          slab: `${sf.fulfilment_type}: ₹${sf.price_min} - ₹${sf.price_max}`,
          oldRate: parseFloat(match.rate),
          newRate: sf.rate,
          reason: 'Fixed fee amount modified'
        });
      }
    }

    // 3. Check Reverse Shipping Changes
    const activeRevShip = await pool.query(`
      SELECT weight_slab, price_min, price_max, local_fee, zonal_fee, national_fee 
      FROM rc_reverse_shipping 
      WHERE marketplace = $1 AND seller_account = $2 AND category = $3 AND end_date IS NULL
    `, [marketplace, sellerAccount, vertical]);

    for (const sr of reverseShipping) {
      const match = activeRevShip.rows.find(ar =>
        ar.weight_slab === sr.weight_slab &&
        Math.abs(parseFloat(ar.price_min) - sr.price_min) < 0.01
      );
      if (!match) {
        changes.push({
          type: 'reverse_shipping',
          category: vertical,
          slab: `${sr.weight_slab} (₹${sr.price_min} - ₹${sr.price_max})`,
          oldRate: null,
          newRate: `Local: ₹${sr.local_fee}, Zonal: ₹${sr.zonal_fee}, Nat: ₹${sr.national_fee}`,
          reason: 'New reverse shipping weight/price slab'
        });
      } else if (
        Math.abs(parseFloat(match.local_fee) - sr.local_fee) > 0.01 ||
        Math.abs(parseFloat(match.zonal_fee) - sr.zonal_fee) > 0.01 ||
        Math.abs(parseFloat(match.national_fee) - sr.national_fee) > 0.01
      ) {
        changes.push({
          type: 'reverse_shipping',
          category: vertical,
          slab: `${sr.weight_slab} (₹${sr.price_min} - ₹${sr.price_max})`,
          oldRate: `Local: ₹${match.local_fee}, Zonal: ₹${match.zonal_fee}, Nat: ₹${match.national_fee}`,
          newRate: `Local: ₹${sr.local_fee}, Zonal: ₹${sr.zonal_fee}, Nat: ₹${sr.national_fee}`,
          reason: 'Reverse shipping fees adjusted'
        });
      }
    }
  }

  return changes;
}

/**
 * Commit scraped rate cards to DB with versioning & auto-closure
 */
export async function syncRateCardsToDatabase(scrapedList, options = {}) {
  const {
    marketplace = 'flipkart',
    sellerAccount = 'default',
    effectiveDate = new Date().toISOString().slice(0, 10),
    forceUpdate = false
  } = options;

  const pool = getPool();
  const changes = await detectRateChanges(scrapedList, marketplace, sellerAccount);

  if (changes.length === 0 && !forceUpdate) {
    return {
      updated: false,
      message: 'Rate cards are already in sync with Flipkart. No rate changes detected.',
      changes: []
    };
  }

  const client = await pool.connect();
  const previousEndDate = dayBefore(effectiveDate);

  try {
    await client.query('BEGIN');

    // Group scraped data by vertical
    for (const scraped of scrapedList) {
      const { vertical, commissions, fixedFees, collectionFees, reverseShipping } = scraped;

      // 1. Sync Commissions
      if (commissions.length > 0) {
        await client.query(`
          DELETE FROM rc_commission 
          WHERE marketplace = $1 AND seller_account = $2 AND category = $3 
            AND start_date >= $4::date AND end_date IS NULL
        `, [marketplace, sellerAccount, vertical, effectiveDate]);

        await client.query(`
          UPDATE rc_commission 
          SET end_date = $1::date, updated_at = NOW() 
          WHERE marketplace = $2 AND seller_account = $3 AND category = $4 
            AND start_date < $5::date AND (end_date IS NULL OR end_date >= $5::date)
        `, [previousEndDate, marketplace, sellerAccount, vertical, effectiveDate]);

        for (const c of commissions) {
          await client.query(`
            INSERT INTO rc_commission (category, marketplace, seller_account, price_min, price_max, rate, start_date, end_date, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NOW())
          `, [vertical, marketplace, sellerAccount, c.price_min, c.price_max, c.rate, effectiveDate]);
        }
      }

      // 2. Sync Fixed Fees
      if (fixedFees.length > 0) {
        await client.query(`
          DELETE FROM rc_fixed_fee 
          WHERE marketplace = $1 AND seller_account = $2 AND category = $3 
            AND start_date >= $4::date AND end_date IS NULL
        `, [marketplace, sellerAccount, vertical, effectiveDate]);

        await client.query(`
          UPDATE rc_fixed_fee 
          SET end_date = $1::date, updated_at = NOW() 
          WHERE marketplace = $2 AND seller_account = $3 AND category = $4 
            AND start_date < $5::date AND (end_date IS NULL OR end_date >= $5::date)
        `, [previousEndDate, marketplace, sellerAccount, vertical, effectiveDate]);

        for (const f of fixedFees) {
          await client.query(`
            INSERT INTO rc_fixed_fee (category, marketplace, seller_account, fulfilment_type, price_min, price_max, rate, start_date, end_date, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NOW())
          `, [vertical, marketplace, sellerAccount, f.fulfilment_type, f.price_min, f.price_max, f.rate, effectiveDate]);
        }
      }

      // 3. Sync Collection Fees
      if (collectionFees.length > 0) {
        await client.query(`
          DELETE FROM rc_collection_fee 
          WHERE marketplace = $1 AND seller_account = $2 AND category = $3 
            AND start_date >= $4::date AND end_date IS NULL
        `, [marketplace, sellerAccount, vertical, effectiveDate]);

        await client.query(`
          UPDATE rc_collection_fee 
          SET end_date = $1::date, updated_at = NOW() 
          WHERE marketplace = $2 AND seller_account = $3 AND category = $4 
            AND start_date < $5::date AND (end_date IS NULL OR end_date >= $5::date)
        `, [previousEndDate, marketplace, sellerAccount, vertical, effectiveDate]);

        for (const cf of collectionFees) {
          await client.query(`
            INSERT INTO rc_collection_fee (category, marketplace, seller_account, fulfilment_type, price_min, price_max, prepaid, postpaid, prepaid_type, postpaid_type, start_date, end_date, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, NOW())
          `, [vertical, marketplace, sellerAccount, cf.fulfilment_type, cf.price_min, cf.price_max, cf.prepaid, cf.postpaid, cf.prepaid_type, cf.postpaid_type, effectiveDate]);
        }
      }

      // 4. Sync Reverse Shipping
      if (reverseShipping.length > 0) {
        await client.query(`
          DELETE FROM rc_reverse_shipping 
          WHERE marketplace = $1 AND seller_account = $2 AND category = $3 
            AND start_date >= $4::date AND end_date IS NULL
        `, [marketplace, sellerAccount, vertical, effectiveDate]);

        await client.query(`
          UPDATE rc_reverse_shipping 
          SET end_date = $1::date, updated_at = NOW() 
          WHERE marketplace = $2 AND seller_account = $3 AND category = $4 
            AND start_date < $5::date AND (end_date IS NULL OR end_date >= $5::date)
        `, [previousEndDate, marketplace, sellerAccount, vertical, effectiveDate]);

        for (const r of reverseShipping) {
          await client.query(`
            INSERT INTO rc_reverse_shipping (category, marketplace, seller_account, weight_slab, price_min, price_max, local_fee, zonal_fee, national_fee, start_date, end_date, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NOW())
          `, [vertical, marketplace, sellerAccount, r.weight_slab, r.price_min, r.price_max, r.local_fee, r.zonal_fee, r.national_fee, effectiveDate]);
        }
      }
    }

    // 5. Publish Immutable Version Snapshot in rate_card_versions
    const versionName = `auto-flipkart-${effectiveDate}-${Date.now().toString().slice(-4)}`;
    await client.query(`
      INSERT INTO rate_card_versions (marketplace, seller_account, version_name, status, effective_from, snapshot, created_at, published_at)
      VALUES ($1, $2, $3, 'published', $4, $5, NOW(), NOW())
    `, [marketplace, sellerAccount, versionName, effectiveDate, JSON.stringify({ changes, itemsCount: scrapedList.length })]);

    await client.query('COMMIT');
    clearRateCardCache();

    // Trigger Notification
    sendRateCardNotification({ marketplace, effectiveDate, changes });

    return {
      updated: true,
      versionName,
      changesCount: changes.length,
      changes,
      effectiveDate
    };

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Dispatch Rate Card Change Alert
 */
export async function sendRateCardNotification({ marketplace, effectiveDate, changes }) {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    const toEmail = process.env.RATE_CARD_NOTIFICATION_TO || 'payments@youthnic.shop';
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'reco@youthnic.shop';

    if (!apiKey) {
      console.log('[RateCardSync] Resend API key missing, skipping email notification.');
      return;
    }

    const changeRows = changes.map(c => `
      <tr>
        <td style="padding: 6px; border: 1px solid #ddd;">${c.type}</td>
        <td style="padding: 6px; border: 1px solid #ddd;"><strong>${c.category}</strong></td>
        <td style="padding: 6px; border: 1px solid #ddd;">${c.slab}</td>
        <td style="padding: 6px; border: 1px solid #ddd; color: #b00;">${c.oldRate ?? 'None'}</td>
        <td style="padding: 6px; border: 1px solid #ddd; color: #080;">${c.newRate}</td>
      </tr>
    `).join('');

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 650px; margin: 0 auto; color: #333;">
        <h2 style="color: #902A4A; border-bottom: 2px solid #902A4A; padding-bottom: 8px;">
          Flipkart Rate Card Update Alert
        </h2>
        <p>ReconCentral automated rate card worker detected <strong>${changes.length} rate changes</strong> on Flipkart effective from <strong>${effectiveDate}</strong>.</p>
        <table style="width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 13px;">
          <thead>
            <tr style="background-color: #fbe9f0; color: #902A4A;">
              <th style="padding: 8px; border: 1px solid #ddd;">Fee Type</th>
              <th style="padding: 8px; border: 1px solid #ddd;">Category</th>
              <th style="padding: 8px; border: 1px solid #ddd;">Slab / Condition</th>
              <th style="padding: 8px; border: 1px solid #ddd;">Previous Rate</th>
              <th style="padding: 8px; border: 1px solid #ddd;">New Rate</th>
            </tr>
          </thead>
          <tbody>
            ${changeRows}
          </tbody>
        </table>
        <p style="margin-top: 20px; font-size: 12px; color: #666;">
          Database rate cards have been versioned and auto-closed. Reconciliation calculations are now using the new fee structure.
        </p>
      </div>
    `;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: `[ReconCentral] Flipkart Rate Card Update Detected (${changes.length} Changes) - Effective ${effectiveDate}`,
        html
      })
    });

    if (res.ok) {
      console.log(`[RateCardSync] Notification email sent successfully to ${toEmail}`);
    } else {
      console.warn(`[RateCardSync] Failed to send email via Resend: ${res.statusText}`);
    }
  } catch (err) {
    console.error('[RateCardSync] Notification error:', err.message);
  }
}
