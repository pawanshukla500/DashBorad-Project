const DEFAULT_RECIPIENT = 'payments@youthnic.shop';
const MAX_ERROR_LENGTH = 500;

function emailConfig() {
  const recipient = (process.env.RATE_CARD_NOTIFICATION_TO || DEFAULT_RECIPIENT)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return {
    recipient,
    apiKey: process.env.RESEND_API_KEY?.trim() || '',
    from: process.env.RESEND_FROM_EMAIL?.trim() || '',
  };
}

function whatsAppConfig() {
  const recipient = (process.env.RATE_CARD_WHATSAPP_TO || process.env.WHATSAPP_TO || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return {
    recipient,
    apiUrl: process.env.WHATSAPP_API_URL?.trim() || process.env.WHATSAPP_WEBHOOK_URL?.trim() || '',
    token: process.env.WHATSAPP_AUTH_TOKEN?.trim() || process.env.WHATSAPP_API_KEY?.trim() || '',
    from: process.env.WHATSAPP_FROM?.trim() || '',
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function printableValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function changedFields(previous, current) {
  if (previous && !current) {
    return Object.entries(previous)
      .filter(([key]) => !['id', 'updated_at', 'uploaded_at'].includes(key))
      .map(([field, before]) => ({ field, before, after: undefined }));
  }
  if (!previous || !current) return [];
  const ignore = new Set(['id', 'updated_at', 'uploaded_at']);
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...keys]
    .filter(key => !ignore.has(key) && printableValue(previous[key]) !== printableValue(current[key]))
    .map(key => ({ field: key, before: previous[key], after: current[key] }));
}

function eventLabel(action) {
  return {
    created: 'row added',
    updated: 'row updated',
    deleted: 'row deleted',
    period_saved: 'rate period saved',
    seeded: 'rate-card data reseeded',
    version_published: 'version published',
    version_rolled_back: 'version rolled back',
    test: 'delivery test',
  }[action] || 'rate card changed';
}

export function getRateCardNotificationConfig() {
  const config = emailConfig();
  const wa = whatsAppConfig();
  const missing = [];
  if (!config.apiKey) missing.push('RESEND_API_KEY');
  if (!config.from) missing.push('RESEND_FROM_EMAIL');
  const waMissing = [];
  if (!wa.apiUrl) waMissing.push('WHATSAPP_API_URL');
  if (!wa.recipient.length) waMissing.push('WHATSAPP_TO');
  return {
    recipient: config.recipient.join(', '),
    configured: missing.length === 0,
    missing,
    whatsAppRecipient: wa.recipient.join(', '),
    whatsAppConfigured: waMissing.length === 0,
    whatsAppMissing: waMissing,
    deliveryMeaning: 'Accepted means provider accepted message for delivery. Inbox/chat confirmation requires webhooks.',
  };
}

function messageFor(change) {
  const action = change.action || 'updated';
  const label = eventLabel(action);
  const marketplace = change.marketplace || 'flipkart';
  const sellerAccount = change.sellerAccount || 'default';
  const feeType = change.feeType ? ` · ${change.feeType.replace(/_/g, ' ')}` : '';
  const subject = `[Payments] ${marketplace}/${sellerAccount}${feeType}: ${label}`;
  const changes = changedFields(change.previousRow, change.row);
  const details = changes.length
    ? changes
    : Object.entries(change.row || {})
      .filter(([key]) => !['id', 'updated_at', 'uploaded_at'].includes(key))
      .map(([field, after]) => ({ field, before: undefined, after }));
  const summary = [
    `Action: ${label}`,
    `Marketplace: ${marketplace}`,
    `Seller account: ${sellerAccount}`,
    change.feeType ? `Fee type: ${change.feeType}` : null,
    change.actor?.email ? `Changed by: ${change.actor.email}` : null,
    Number.isFinite(change.insertedCount) ? `Rows added: ${change.insertedCount}` : null,
  ].filter(Boolean);
  const lines = [...summary, '', ...details.slice(0, 20).map(item =>
    item.before === undefined
      ? `${item.field}: ${printableValue(item.after)}`
      : `${item.field}: ${printableValue(item.before)} → ${printableValue(item.after)}`
  )];
  const htmlRows = details.slice(0, 20).map(item => `
    <tr>
      <td style="padding:6px 10px;border:1px solid #e2e8f0">${escapeHtml(item.field)}</td>
      <td style="padding:6px 10px;border:1px solid #e2e8f0">${escapeHtml(item.before === undefined ? '—' : printableValue(item.before))}</td>
      <td style="padding:6px 10px;border:1px solid #e2e8f0">${escapeHtml(printableValue(item.after))}</td>
    </tr>`).join('');
  const html = `
    <div style="font-family:Arial,sans-serif;color:#1e293b;line-height:1.45">
      <h2 style="margin:0 0 12px">Rate card ${escapeHtml(label)}</h2>
      ${summary.map(line => `<p style="margin:4px 0">${escapeHtml(line)}</p>`).join('')}
      ${details.length ? `<table style="margin-top:16px;border-collapse:collapse;font-size:13px">
        <thead><tr><th style="padding:6px 10px;border:1px solid #e2e8f0;text-align:left">Field</th><th style="padding:6px 10px;border:1px solid #e2e8f0;text-align:left">Before</th><th style="padding:6px 10px;border:1px solid #e2e8f0;text-align:left">After</th></tr></thead>
        <tbody>${htmlRows}</tbody>
      </table>` : ''}
      <p style="margin-top:18px;color:#64748b;font-size:12px">This message was generated by the payment reconciliation application.</p>
    </div>`;
  return { subject, text: lines.join('\n'), html, changes };
}

async function writeLog(pool, values) {
  let queryable = pool;
  let shouldRelease = false;
  if (!queryable || typeof queryable.query !== 'function') {
    if (pool && typeof pool.connect === 'function') {
      queryable = await pool.connect();
      shouldRelease = true;
    } else {
      queryable = getPool();
    }
  }

  try {
    const result = await queryable.query(
      `INSERT INTO rate_card_notification_log
        (event_type, recipient, subject, payload, status, provider_message_id, error_message, sent_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)
       RETURNING id, event_type, recipient, subject, status, provider_message_id, error_message, created_at, sent_at`,
      [
        values.eventType, values.recipient, values.subject, JSON.stringify(values.payload), values.status,
        values.providerMessageId || null, values.errorMessage || null, values.sentAt || null,
      ]
    );
    return result.rows[0];
  } finally {
    if (shouldRelease && typeof queryable?.release === 'function') {
      queryable.release();
    }
  }
}

export async function sendRateCardNotification(pool, change) {
  const config = emailConfig();
  const { subject, text, html, changes } = messageFor(change);
  const payload = {
    action: change.action || 'updated', marketplace: change.marketplace || 'flipkart',
    sellerAccount: change.sellerAccount || 'default', feeType: change.feeType || null,
    actor: change.actor?.email || null, rowId: change.row?.id || change.previousRow?.id || null,
    changes, insertedCount: change.insertedCount ?? null,
  };

  if (!config.apiKey || !config.from) {
    return writeLog(pool, {
      eventType: payload.action, recipient: config.recipient.join(', '), subject, payload,
      status: 'skipped', errorMessage: `Missing ${!config.apiKey ? 'RESEND_API_KEY' : 'RESEND_FROM_EMAIL'}`,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.from, to: config.recipient, subject, text, html }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = String(body?.message || body?.error || `Resend responded ${response.status}`).slice(0, MAX_ERROR_LENGTH);
      return writeLog(pool, { eventType: payload.action, recipient: config.recipient.join(', '), subject, payload, status: 'failed', errorMessage: message });
    }
    return writeLog(pool, {
      eventType: payload.action, recipient: config.recipient.join(', '), subject, payload,
      status: 'accepted', providerMessageId: body?.id || null, sentAt: new Date(),
    });
  } catch (error) {
    return writeLog(pool, {
      eventType: payload.action, recipient: config.recipient.join(', '), subject, payload,
      status: 'failed', errorMessage: String(error.message || error).slice(0, MAX_ERROR_LENGTH),
    });
  } finally {
    clearTimeout(timer);
  }
}

// Reused by payment reports that need the same audited Resend delivery path.
// Keeping this here means every finance email records the provider acceptance
// (or an actionable missing-config/error state) in one place.
export async function sendPaymentNotification(pool, { eventType, subject, text, html, payload = {} }) {
  const config = emailConfig();
  const recipient = config.recipient.join(', ');
  if (!config.apiKey || !config.from) {
    return writeLog(pool, {
      eventType, recipient, subject, payload,
      status: 'skipped', errorMessage: `Missing ${!config.apiKey ? 'RESEND_API_KEY' : 'RESEND_FROM_EMAIL'}`,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.from, to: config.recipient, subject, text, html }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage = String(body?.message || body?.error || `Resend responded ${response.status}`).slice(0, MAX_ERROR_LENGTH);
      return writeLog(pool, { eventType, recipient, subject, payload, status: 'failed', errorMessage });
    }
    return writeLog(pool, {
      eventType, recipient, subject, payload, status: 'accepted',
      providerMessageId: body?.id || null, sentAt: new Date(),
    });
  } catch (error) {
    return writeLog(pool, {
      eventType, recipient, subject, payload, status: 'failed',
      errorMessage: String(error.message || error).slice(0, MAX_ERROR_LENGTH),
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function getRateCardNotificationStatus(pool) {
  const config = getRateCardNotificationConfig();
  const result = await pool.query(
    `SELECT id, event_type, recipient, subject, status, provider_message_id, error_message, created_at, sent_at
     FROM rate_card_notification_log ORDER BY created_at DESC LIMIT 20`
  );
  return { ...config, events: result.rows };
}

export async function sendRateCardNotificationTest(pool, actor) {
  return sendRateCardNotification(pool, {
    action: 'test', marketplace: 'system', sellerAccount: 'system', actor,
    row: { message: 'This is an administrator-requested Resend delivery test.' },
  });
}

export async function sendWhatsAppNotification(pool, { eventType = 'rate_card_alert', subject = 'Rate Card Alert', text, payload = {} }) {
  const config = whatsAppConfig();
  const recipient = config.recipient.join(', ');
  if (!config.apiUrl || !config.recipient.length) {
    return writeLog(pool, {
      eventType: `whatsapp_${eventType}`,
      recipient: recipient || 'unconfigured',
      subject: `[WhatsApp] ${subject}`,
      payload: { ...payload, channel: 'whatsapp' },
      status: 'skipped',
      errorMessage: !config.apiUrl
        ? 'Missing WHATSAPP_API_URL or WHATSAPP_WEBHOOK_URL'
        : 'Missing RATE_CARD_WHATSAPP_TO or WHATSAPP_TO recipient',
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (config.token) headers['Authorization'] = `Bearer ${config.token}`;

    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        to: config.recipient,
        from: config.from || 'ReconCentral',
        subject,
        text,
        payload
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage = String(body?.message || body?.error || `WhatsApp provider responded ${response.status}`).slice(0, MAX_ERROR_LENGTH);
      return writeLog(pool, {
        eventType: `whatsapp_${eventType}`,
        recipient,
        subject: `[WhatsApp] ${subject}`,
        payload: { ...payload, channel: 'whatsapp' },
        status: 'failed',
        errorMessage
      });
    }
    return writeLog(pool, {
      eventType: `whatsapp_${eventType}`,
      recipient,
      subject: `[WhatsApp] ${subject}`,
      payload: { ...payload, channel: 'whatsapp' },
      status: 'accepted',
      providerMessageId: body?.id || body?.sid || body?.message_id || null,
      sentAt: new Date(),
    });
  } catch (error) {
    return writeLog(pool, {
      eventType: `whatsapp_${eventType}`,
      recipient,
      subject: `[WhatsApp] ${subject}`,
      payload: { ...payload, channel: 'whatsapp' },
      status: 'failed',
      errorMessage: String(error.message || error).slice(0, MAX_ERROR_LENGTH),
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function sendAdminRateCardAlert(pool, alertData) {
  const {
    marketplace = 'flipkart',
    sellerAccount = 'default',
    extractionDate = new Date().toISOString().slice(0, 10),
    effectiveDate = extractionDate,
    validationStatus = 'anomalies_detected',
    anomalies = [],
    changes = [],
    previousVersionName = 'N/A',
    proposedVersionName = 'Pending Approval',
    autoApplied = false,
    requiresApproval = true,
    error = null,
  } = alertData;

  const isFailure = Boolean(error) || validationStatus === 'incomplete_extraction';
  const hasAnomalies = anomalies.length > 0;

  let badgeColor = '#059669'; // Green
  let badgeText = autoApplied ? 'Auto-Applied to DB' : 'Pending Verification';

  if (isFailure) {
    badgeColor = '#dc2626'; // Red
    badgeText = 'Extraction Failed';
  } else if (hasAnomalies) {
    badgeColor = '#d97706'; // Amber
    badgeText = 'Requires Administrator Approval';
  }

  const subject = isFailure
    ? `🚨 [ALERT] ${marketplace.toUpperCase()} Fee Extraction Failed (${extractionDate})`
    : hasAnomalies
    ? `⚠️ [ANOMALY ALERT] ${marketplace.toUpperCase()} Rate Card Shift: ${anomalies.length} Anomaly Flagged (${extractionDate})`
    : `ℹ️ [RATE UPDATE] ${marketplace.toUpperCase()} Rate Card: ${changes.length} Parameter Change(s) (${extractionDate})`;

  // Build WhatsApp Text
  const waLines = [
    `${isFailure ? '🚨' : hasAnomalies ? '⚠️' : 'ℹ️'} *[ReconCentral] Rate Card Alert*`,
    `*Marketplace:* ${marketplace.toUpperCase()} (${sellerAccount})`,
    `*Extraction Date:* ${extractionDate}`,
    `*Effective Date:* ${effectiveDate}`,
    `*Status:* ${badgeText}`,
    '',
    `*Previous Version:* ${previousVersionName}`,
    `*Proposed Version:* ${proposedVersionName}`,
    `*Approval Status:* ${autoApplied ? '✅ Auto-Published' : '⏳ Requires Admin Approval'}`,
    ''
  ];

  if (isFailure) {
    waLines.push(`*Failure Detail:* ${error || 'Incomplete extraction or missing required fee parameters'}`);
  }

  if (hasAnomalies) {
    waLines.push(`*Flagged Anomalies (${anomalies.length}):*`);
    for (const a of anomalies.slice(0, 5)) {
      waLines.push(`• ${a.reason || a.type}`);
    }
    if (anomalies.length > 5) {
      waLines.push(`  _...and ${anomalies.length - 5} more anomalies._`);
    }
    waLines.push('');
  }

  if (changes.length > 0) {
    waLines.push(`*Key Fee Adjustments (${changes.length}):*`);
    for (const c of changes.slice(0, 6)) {
      const slabStr = c.slab ? ` [${c.slab}]` : '';
      const oldStr = c.oldRate != null ? (typeof c.oldRate === 'number' && c.type === 'commission' ? `${(c.oldRate * 100).toFixed(1)}%` : String(c.oldRate)) : 'None';
      const newStr = c.newRate != null ? (typeof c.newRate === 'number' && c.type === 'commission' ? `${(c.newRate * 100).toFixed(1)}%` : String(c.newRate)) : '—';
      const diffStr = c.difference ? ` (${c.difference})` : '';
      waLines.push(`• *${c.type || 'Fee'}* ${c.category || ''}${slabStr}: ${oldStr} → ${newStr}${diffStr}`);
    }
    if (changes.length > 6) {
      waLines.push(`  _...and ${changes.length - 6} more changes._`);
    }
  }

  waLines.push('');
  waLines.push('🔗 Open ReconCentral Desktop App to inspect and review.');
  const whatsAppText = waLines.join('\n');

  // Build HTML Email
  const changeRowsHtml = changes.slice(0, 25).map(c => `
    <tr>
      <td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600">${escapeHtml(c.type || 'Fee')}</td>
      <td style="padding:8px 12px;border:1px solid #e2e8f0">${escapeHtml(c.category || 'All')} ${c.slab ? `(${escapeHtml(c.slab)})` : ''}</td>
      <td style="padding:8px 12px;border:1px solid #e2e8f0">${escapeHtml(printableValue(c.oldRate))}</td>
      <td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600">${escapeHtml(printableValue(c.newRate))}</td>
      <td style="padding:8px 12px;border:1px solid #e2e8f0">${escapeHtml(c.difference || '—')}</td>
      <td style="padding:8px 12px;border:1px solid #e2e8f0">${escapeHtml(c.recommendation || c.reason || '—')}</td>
    </tr>
  `).join('');

  const emailHtml = `
    <div style="font-family:Arial,sans-serif;color:#1e293b;max-width:700px;margin:0 auto;line-height:1.5">
      <div style="border-bottom:2px solid #902A4A;padding-bottom:12px;margin-bottom:16px">
        <h2 style="margin:0;color:#902A4A;font-size:20px">ReconCentral Rate Card Monitoring Alert</h2>
        <p style="margin:4px 0 0;color:#64748b;font-size:13px">Marketplace fee changes, daily anomaly detection, and rate card versioning</p>
      </div>

      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:20px">
        <div style="display:flex;justify-content:space-between;margin-bottom:8px">
          <span style="font-size:14px;color:#475569">Status:</span>
          <span style="background:${badgeColor};color:#ffffff;padding:3px 10px;border-radius:4px;font-size:12px;font-weight:bold">${escapeHtml(badgeText)}</span>
        </div>
        <p style="margin:4px 0"><strong>Marketplace:</strong> ${escapeHtml(marketplace.toUpperCase())} (${escapeHtml(sellerAccount)})</p>
        <p style="margin:4px 0"><strong>Extraction Date:</strong> ${escapeHtml(extractionDate)} | <strong>Effective Date:</strong> ${escapeHtml(effectiveDate)}</p>
        <p style="margin:4px 0"><strong>Previous Version:</strong> ${escapeHtml(previousVersionName)} → <strong>Proposed Version:</strong> ${escapeHtml(proposedVersionName)}</p>
        <p style="margin:4px 0"><strong>Action Mode:</strong> ${autoApplied ? 'Automatically Synchronized to Database' : 'Requires Explicit Administrator Approval'}</p>
        ${error ? `<p style="margin:8px 0 0;color:#dc2626"><strong>Error:</strong> ${escapeHtml(error)}</p>` : ''}
      </div>

      ${hasAnomalies ? `
        <div style="background:#fffbeb;border:1px solid #fef3c7;border-left:4px solid #f59e0b;padding:12px;border-radius:4px;margin-bottom:20px">
          <h4 style="margin:0 0 8px;color:#b45309">⚠️ Flagged Anomalies (${anomalies.length})</h4>
          <ul style="margin:0;padding-left:20px;font-size:13px;color:#92400e">
            ${anomalies.map(a => `<li>${escapeHtml(a.reason || a.type)}</li>`).join('')}
          </ul>
        </div>
      ` : ''}

      ${changes.length ? `
        <h3 style="margin:16px 0 8px;font-size:16px">Detected Rate Adjustments (${changes.length})</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px">
          <thead>
            <tr style="background:#f1f5f9;text-align:left">
              <th style="padding:8px 12px;border:1px solid #e2e8f0">Component</th>
              <th style="padding:8px 12px;border:1px solid #e2e8f0">Scope / Slab</th>
              <th style="padding:8px 12px;border:1px solid #e2e8f0">Previous</th>
              <th style="padding:8px 12px;border:1px solid #e2e8f0">New Rate</th>
              <th style="padding:8px 12px;border:1px solid #e2e8f0">Diff</th>
              <th style="padding:8px 12px;border:1px solid #e2e8f0">Guidance</th>
            </tr>
          </thead>
          <tbody>
            ${changeRowsHtml}
          </tbody>
        </table>
      ` : '<p style="color:#64748b;font-style:italic">No individual slab adjustments detected.</p>'}

      <p style="margin-top:24px;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:12px">
        This automated notification was generated by the ReconCentral RateCard Monitoring & Validation Engine.
      </p>
    </div>
  `;

  // Dispatch Email and WhatsApp in parallel with error containment
  const [emailResult, whatsAppResult] = await Promise.allSettled([
    sendPaymentNotification(pool, {
      eventType: isFailure ? 'extraction_failed' : hasAnomalies ? 'rate_anomaly_detected' : 'rate_card_updated',
      subject,
      text: whatsAppText,
      html: emailHtml,
      payload: {
        marketplace,
        sellerAccount,
        extractionDate,
        effectiveDate,
        validationStatus,
        anomaliesCount: anomalies.length,
        changesCount: changes.length,
        autoApplied,
        requiresApproval,
      }
    }),
    sendWhatsAppNotification(pool, {
      eventType: isFailure ? 'extraction_failed' : hasAnomalies ? 'rate_anomaly_detected' : 'rate_card_updated',
      subject,
      text: whatsAppText,
      payload: {
        marketplace,
        sellerAccount,
        extractionDate,
        effectiveDate,
        validationStatus,
        anomaliesCount: anomalies.length,
        changesCount: changes.length,
        autoApplied,
        requiresApproval,
      }
    })
  ]);

  return {
    email: emailResult.status === 'fulfilled' ? emailResult.value : { status: 'failed', error: emailResult.reason?.message },
    whatsapp: whatsAppResult.status === 'fulfilled' ? whatsAppResult.value : { status: 'failed', error: whatsAppResult.reason?.message }
  };
}

