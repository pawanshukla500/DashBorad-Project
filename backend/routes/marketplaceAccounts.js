import express from 'express';
import { getPool } from '../db/index.js';
import { requireRole, requireAdmin } from '../utils/authMiddleware.js';
import { encryptCredential, decryptCredential, maskCredential } from '../utils/credentialCrypto.js';

const router = express.Router();

/**
 * Standard Brandfetch logos and portal URLs fallback map
 */
export const DEFAULT_MARKETPLACE_METADATA = {
  amazon: {
    display_name: 'Amazon IN',
    portal_url: 'https://sellercentral.amazon.in/',
    logo_url: 'https://cdn.brandfetch.io/idomDO5Jzv/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177472711idZyD0yYjDdIjVoG73',
  },
  flipkart: {
    display_name: 'Flipkart',
    portal_url: 'https://seller.flipkart.com/',
    logo_url: 'https://cdn.brandfetch.io/idWdImNSUt/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177459816idZyD0yYjDWqQ88x6B',
  },
  myntra: {
    display_name: 'Myntra',
    portal_url: 'https://partners.myntra.com/',
    logo_url: 'https://cdn.brandfetch.io/idDW82Qwj2/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177484037idZyD0yYjDtAenWdeL',
  },
  ajio: {
    display_name: 'Reliance Retail (AJIO)',
    portal_url: 'https://supplier.ajio.com/',
    logo_url: 'https://cdn.brandfetch.io/idr5xgDFc2/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177490710idZyD0yYjDeHmQHVu1',
  },
  meesho: {
    display_name: 'Meesho',
    portal_url: 'https://supplier.meesho.com/',
    logo_url: 'https://cdn.brandfetch.io/idyeTDctmi/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177498057idZyD0yYjDdWnJrl50',
  },
  cocoblu: {
    display_name: 'Cocoblu Retails',
    portal_url: 'https://cocoblu.biz/',
    logo_url: 'https://cdn.brandfetch.io/iduQ6iAglk/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177520125idZyD0yYjDnFplzDd_',
  },
  shopify: {
    display_name: 'Shopify',
    portal_url: 'https://admin.shopify.com/',
    logo_url: 'https://cdn.brandfetch.io/idAgPm7IvG/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177511905idZyD0yYjDkUgFPWU1',
  },
};

/**
 * GET /api/marketplace-accounts
 * 
 * Lists all marketplace accounts with Brandfetch logos, masked passwords,
 * and current configuration state.
 */
router.get('/', async (req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT 
        id,
        marketplace,
        account_id,
        display_name,
        seller_id,
        login_id,
        password_encrypted,
        portal_url,
        logo_url,
        auth_type,
        metadata,
        is_active,
        created_at,
        updated_at,
        updated_by
      FROM marketplace_accounts
      WHERE is_active = true OR account_id IN ('myntra_vb', 'myntra_ej')
      ORDER BY 
        CASE 
          WHEN marketplace = 'flipkart' THEN 1
          WHEN marketplace = 'amazon' THEN 2
          WHEN marketplace = 'myntra' AND account_id = 'myntra_vb' THEN 3
          WHEN marketplace = 'myntra' AND account_id = 'myntra_ej' THEN 4
          WHEN marketplace = 'ajio' THEN 5
          WHEN marketplace = 'meesho' THEN 6
          WHEN marketplace = 'cocoblu' THEN 7
          WHEN marketplace = 'shopify' THEN 8
          ELSE 9
        END,
        id ASC
    `);

    const sanitized = rows.map(r => ({
      id: r.id,
      marketplace: r.marketplace,
      account_id: r.account_id,
      display_name: r.display_name,
      seller_id: r.seller_id,
      login_id: r.login_id || '',
      has_password: Boolean(r.password_encrypted),
      password_masked: maskCredential(r.password_encrypted),
      portal_url: r.portal_url || DEFAULT_MARKETPLACE_METADATA[r.marketplace]?.portal_url || '',
      logo_url: r.logo_url || DEFAULT_MARKETPLACE_METADATA[r.marketplace]?.logo_url || '',
      auth_type: r.auth_type || 'password',
      metadata: r.metadata || {},
      is_active: r.is_active,
      created_at: r.created_at,
      updated_at: r.updated_at,
      updated_by: r.updated_by,
    }));

    return res.json({ accounts: sanitized });
  } catch (err) {
    console.error('[marketplace-accounts] fetch error:', err);
    return res.status(500).json({ error: 'Failed to retrieve marketplace accounts' });
  }
});

/**
 * GET /api/marketplace-accounts/:id/reveal
 * 
 * Reveals the decrypted password for an account (Operator or Admin only).
 */
router.get('/:id/reveal', requireRole('operator', 'admin'), async (req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, marketplace, account_id, login_id, password_encrypted FROM marketplace_accounts WHERE id = $1`,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Marketplace account not found' });
    }

    const acc = rows[0];
    const password = decryptCredential(acc.password_encrypted);

    return res.json({
      id: acc.id,
      marketplace: acc.marketplace,
      account_id: acc.account_id,
      login_id: acc.login_id || '',
      password: password || '',
    });
  } catch (err) {
    console.error('[marketplace-accounts] reveal error:', err);
    return res.status(500).json({ error: 'Failed to decrypt credential' });
  }
});

/**
 * POST /api/marketplace-accounts
 * 
 * Upserts a marketplace account and encrypts any provided password.
 * Strict Myntra Invariant:
 *   - myntra_vb: seller_id = '10708'
 *   - myntra_ej: seller_id = '45833'
 */
router.post('/', requireRole('operator', 'admin'), async (req, res) => {
  const {
    marketplace,
    account_id = 'default',
    display_name,
    seller_id,
    login_id,
    password,
    portal_url,
    logo_url,
    auth_type = 'password',
    metadata = {},
    is_active = true,
  } = req.body;

  if (!marketplace || typeof marketplace !== 'string') {
    return res.status(400).json({ error: 'Marketplace key is required' });
  }

  const cleanMarketplace = marketplace.trim().toLowerCase();
  const cleanAccountId = (account_id || 'default').trim();
  const cleanDisplayName = display_name ? display_name.trim() : (DEFAULT_MARKETPLACE_METADATA[cleanMarketplace]?.display_name || cleanMarketplace);

  // Enforce Myntra dual-account separation invariant
  let finalSellerId = seller_id ? String(seller_id).trim() : null;
  if (cleanMarketplace === 'myntra') {
    if (cleanAccountId === 'myntra_vb') {
      finalSellerId = '10708';
    } else if (cleanAccountId === 'myntra_ej') {
      finalSellerId = '45833';
    }
  }

  const encryptedPassword = password ? encryptCredential(password) : null;
  const finalPortalUrl = portal_url || DEFAULT_MARKETPLACE_METADATA[cleanMarketplace]?.portal_url || null;
  const finalLogoUrl = logo_url || DEFAULT_MARKETPLACE_METADATA[cleanMarketplace]?.logo_url || null;
  const updatedBy = req.user?.username || req.user?.email || 'admin';

  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO marketplace_accounts (
        marketplace, account_id, display_name, seller_id, login_id,
        password_encrypted, portal_url, logo_url, auth_type, metadata,
        is_active, updated_at, updated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12)
      ON CONFLICT (marketplace, account_id)
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        seller_id = COALESCE(EXCLUDED.seller_id, marketplace_accounts.seller_id),
        login_id = COALESCE(EXCLUDED.login_id, marketplace_accounts.login_id),
        password_encrypted = CASE WHEN EXCLUDED.password_encrypted IS NOT NULL THEN EXCLUDED.password_encrypted ELSE marketplace_accounts.password_encrypted END,
        portal_url = COALESCE(EXCLUDED.portal_url, marketplace_accounts.portal_url),
        logo_url = COALESCE(EXCLUDED.logo_url, marketplace_accounts.logo_url),
        auth_type = EXCLUDED.auth_type,
        metadata = EXCLUDED.metadata,
        is_active = EXCLUDED.is_active,
        updated_at = NOW(),
        updated_by = EXCLUDED.updated_by
      RETURNING id, marketplace, account_id, display_name, seller_id, login_id, portal_url, logo_url, auth_type, is_active, updated_at`,
      [
        cleanMarketplace,
        cleanAccountId,
        cleanDisplayName,
        finalSellerId,
        login_id ? String(login_id).trim() : null,
        encryptedPassword,
        finalPortalUrl,
        finalLogoUrl,
        auth_type,
        JSON.stringify(metadata),
        Boolean(is_active),
        updatedBy,
      ]
    );

    return res.status(200).json({
      success: true,
      account: rows[0],
      message: `Account ${cleanDisplayName} configured successfully`,
    });
  } catch (err) {
    console.error('[marketplace-accounts] upsert error:', err);
    return res.status(500).json({ error: 'Failed to save marketplace credentials' });
  }
});

/**
 * PUT /api/marketplace-accounts/:id
 * 
 * Updates credentials and settings for an existing account.
 */
router.put('/:id', requireRole('operator', 'admin'), async (req, res) => {
  const { id } = req.params;
  const {
    display_name,
    seller_id,
    login_id,
    password,
    portal_url,
    logo_url,
    auth_type,
    metadata,
    is_active,
  } = req.body;

  try {
    const pool = getPool();
    const existing = await pool.query('SELECT * FROM marketplace_accounts WHERE id = $1', [id]);
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Marketplace account not found' });
    }

    const current = existing.rows[0];
    const cleanDisplayName = display_name !== undefined ? String(display_name).trim() : current.display_name;

    let finalSellerId = seller_id !== undefined ? String(seller_id).trim() : current.seller_id;
    if (current.marketplace === 'myntra') {
      if (current.account_id === 'myntra_vb') finalSellerId = '10708';
      if (current.account_id === 'myntra_ej') finalSellerId = '45833';
    }

    let finalPasswordEncrypted = current.password_encrypted;
    if (password !== undefined && password !== null) {
      if (password === '') {
        finalPasswordEncrypted = null;
      } else {
        finalPasswordEncrypted = encryptCredential(password);
      }
    }

    const updatedBy = req.user?.username || req.user?.email || 'admin';

    const { rows } = await pool.query(
      `UPDATE marketplace_accounts
       SET
         display_name = $1,
         seller_id = $2,
         login_id = $3,
         password_encrypted = $4,
         portal_url = $5,
         logo_url = $6,
         auth_type = $7,
         metadata = $8,
         is_active = $9,
         updated_at = NOW(),
         updated_by = $10
       WHERE id = $11
       RETURNING id, marketplace, account_id, display_name, seller_id, login_id, portal_url, logo_url, auth_type, is_active, updated_at`,
      [
        cleanDisplayName,
        finalSellerId,
        login_id !== undefined ? String(login_id).trim() : current.login_id,
        finalPasswordEncrypted,
        portal_url !== undefined ? String(portal_url).trim() : current.portal_url,
        logo_url !== undefined ? String(logo_url).trim() : current.logo_url,
        auth_type !== undefined ? auth_type : current.auth_type,
        metadata !== undefined ? JSON.stringify(metadata) : current.metadata,
        is_active !== undefined ? Boolean(is_active) : current.is_active,
        updatedBy,
        id,
      ]
    );

    return res.json({
      success: true,
      account: rows[0],
      message: 'Marketplace credentials updated successfully',
    });
  } catch (err) {
    console.error('[marketplace-accounts] update error:', err);
    return res.status(500).json({ error: 'Failed to update marketplace account' });
  }
});

/**
 * DELETE /api/marketplace-accounts/:id
 * 
 * Soft-deactivates an account (Admin only).
 */
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const pool = getPool();
    const updatedBy = req.user?.username || req.user?.email || 'admin';
    await pool.query(
      `UPDATE marketplace_accounts SET is_active = false, updated_at = NOW(), updated_by = $1 WHERE id = $2`,
      [updatedBy, req.params.id]
    );
    return res.json({ success: true, message: 'Account deactivated' });
  } catch (err) {
    console.error('[marketplace-accounts] delete error:', err);
    return res.status(500).json({ error: 'Failed to deactivate account' });
  }
});

export default router;
