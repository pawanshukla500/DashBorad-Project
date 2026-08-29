import { getRateCardNotificationConfig, sendPaymentNotification } from './rateCardNotifications.js';
import { getSkuSettlementBenchmark } from './skuSettlementBenchmark.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(value) {
  const sign = Number(value) > 0 ? '+' : '';
  return `${sign}₹${Number(value || 0).toFixed(2)}`;
}

/** Send one reviewed report per marketplace/month, never one email per SKU. */
export async function sendSkuSettlementBenchmarkNotification(pool, report, actor) {
  const alerts = report.rows.filter(row => row.has_change_alert);
  if (!report.month) return { status: 'skipped', reason: 'No eligible order month is available yet.' };
  if (!alerts.length) return { status: 'skipped', reason: 'No SKU settlement benchmark changed by more than ₹2.' };

  const eventType = 'sku_settlement_benchmark';
  const existing = await pool.query(
    `SELECT id FROM rate_card_notification_log
     WHERE event_type = $1
       AND status = 'accepted'
       AND payload->>'marketplace' = $2
       AND payload->>'month' = $3
     LIMIT 1`,
    [eventType, report.marketplace, report.month]
  );
  if (existing.rowCount) return { status: 'skipped', reason: 'This marketplace/month alert was already accepted by Resend.', duplicateOf: existing.rows[0].id };

  const shown = alerts.slice(0, 50);
  const lines = [
    `Marketplace: ${report.marketplace}`,
    `Order month: ${report.month}`,
    `Compared with: ${report.previousMonth || 'previous month'}`,
    `SKUs changed by more than ₹2: ${alerts.length}`,
    actor?.email ? `Sent by: ${actor.email}` : null,
    '',
    ...shown.map(row => `${row.sku} (${row.seller_account}): ${money(row.previous_representative_settlement)} → ${money(row.representative_settlement)} (${money(row.change_from_previous)})`),
    alerts.length > shown.length ? `…and ${alerts.length - shown.length} more SKUs in the downloaded benchmark report.` : null,
  ].filter(Boolean);
  const tableRows = shown.map(row => `
    <tr>
      <td style="padding:6px 10px;border:1px solid #e2e8f0">${escapeHtml(row.sku)}</td>
      <td style="padding:6px 10px;border:1px solid #e2e8f0">${escapeHtml(row.seller_account)}</td>
      <td style="padding:6px 10px;border:1px solid #e2e8f0;text-align:right">${escapeHtml(money(row.previous_representative_settlement))}</td>
      <td style="padding:6px 10px;border:1px solid #e2e8f0;text-align:right">${escapeHtml(money(row.representative_settlement))}</td>
      <td style="padding:6px 10px;border:1px solid #e2e8f0;text-align:right">${escapeHtml(money(row.change_from_previous))}</td>
    </tr>`).join('');
  const subject = `[Payments] ${report.marketplace} SKU settlement alert · ${report.month}`;
  const html = `
    <div style="font-family:Arial,sans-serif;color:#1e293b;line-height:1.45">
      <h2 style="margin:0 0 12px">SKU settlement benchmark changed</h2>
      <p>${escapeHtml(report.marketplace)} · ${escapeHtml(report.month)} compared with ${escapeHtml(report.previousMonth || 'the previous month')}.</p>
      <p><strong>${alerts.length}</strong> SKU benchmark${alerts.length === 1 ? '' : 's'} changed by more than ₹2.</p>
      <table style="margin-top:16px;border-collapse:collapse;font-size:13px">
        <thead><tr><th style="padding:6px 10px;border:1px solid #e2e8f0;text-align:left">SKU</th><th style="padding:6px 10px;border:1px solid #e2e8f0;text-align:left">Account</th><th style="padding:6px 10px;border:1px solid #e2e8f0;text-align:right">Previous</th><th style="padding:6px 10px;border:1px solid #e2e8f0;text-align:right">Current</th><th style="padding:6px 10px;border:1px solid #e2e8f0;text-align:right">Change</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
      <p style="margin-top:18px;color:#64748b;font-size:12px">Benchmark = the most frequent per-unit settlement band (±₹0.50). Exact median remains available in the payment report for audit.</p>
    </div>`;

  return sendPaymentNotification(pool, {
    eventType, subject, text: lines.join('\n'), html,
    payload: {
      marketplace: report.marketplace, month: report.month, previousMonth: report.previousMonth,
      alertCount: alerts.length, actor: actor?.email || null,
      alerts: shown.map(row => ({ sku: row.sku, sellerAccount: row.seller_account, previous: row.previous_representative_settlement, current: row.representative_settlement, change: row.change_from_previous })),
    },
  });
}

// Called after a complete settlement import, never while a dashboard is being
// viewed.  Existing accepted notifications are deduplicated by marketplace and
// month in sendSkuSettlementBenchmarkNotification.  A missing Resend setup is
// deliberately silent here: an upload must remain successful even before the
// VPS email variables are configured.
export async function notifySkuSettlementBenchmarkAfterImport(pool, marketplace) {
  if (!getRateCardNotificationConfig().configured) {
    return { status: 'skipped', reason: 'Resend is not configured.' };
  }
  const report = await getSkuSettlementBenchmark(pool, { marketplace, month: null });
  return sendSkuSettlementBenchmarkNotification(pool, report, { email: 'system settlement import' });
}
