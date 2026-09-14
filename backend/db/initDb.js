import bcrypt from 'bcryptjs';
import { getPool, isDbConfigured } from './index.js';
import { AMAZON_BRAND, ensureAmazonSettlementRollups } from '../services/amazonSettlementRollups.js';
import { amazonReportingRollupUnifiedSelect, ensureAmazonSettlementReportingRollups } from '../services/amazonSettlementReportingRollups.js';
import { myntraInvoicesUnifiedSelect } from '../services/myntraSettlementReportingRollups.js';
import { meeshoSettlementUnifiedSelect } from '../services/meeshoSettlementReportingRollups.js';
import { ensureOrderSettlementTotals } from '../services/orderSettlementTotals.js';

// Every item below this version is idempotent but not free: ALTER TABLE takes
// a table lock even when the column already exists. Record completion so a
// normal backend restart is a quick health check rather than a full DDL pass.
const CURRENT_SCHEMA_VERSION = '2026.08.myntra-invoices-unified-1';
const MYNTRA_UPLOAD_SCHEMA_VERSION = '2026.08.myntra-ej-vb-order-return-1';
const MYNTRA_SELLER_ID_SCHEMA_VERSION = '2026.08.myntra-seller-id-guard-1';
const UPLOAD_AUDIT_RETENTION_SCHEMA_VERSION = '2026.08.upload-audit-retention-1';
const NORMALIZED_RATE_CARD_SCHEMA_VERSION = '2026.08.normalized-rate-card-rules-1';
const MP_INVOICE_IDEMPOTENCY_SCHEMA_VERSION = '2026.08.mp-invoice-idempotency-1';
const MYNTRA_PAYMENT_LINKAGE_SCHEMA_VERSION = '2026.09.myntra-payment-linkage-1';
const MYNTRA_ORDER_TYPE_SCHEMA_VERSION = '2026.09.myntra-order-type-1';
const MYNTRA_ITEMIZED_FEES_SCHEMA_VERSION = '2026.09.myntra-itemized-fees-1';
const MP_LEDGER_IDEMPOTENCY_SCHEMA_VERSION = '2026.08.mp-ledger-idempotency-1';
const MYNTRA_RTO_RETURN_DATE_SCHEMA_VERSION = '2026.09.myntra-rto-return-date-1';
const MYNTRA_PARTNER_WH_SCHEMA_VERSION = '2026.09.myntra-partner-warehouse-1';
const MYNTRA_BLANK_TRACKING_RTO_SCHEMA_VERSION = '2026.09.myntra-blank-tracking-rto-1';
const MYNTRA_BLANK_TRACKING_CANCELLED_SCHEMA_VERSION = '2026.09.myntra-blank-tracking-cancelled-2';
const MYNTRA_EJ_RATE_CARDS_SCHEMA_VERSION = '2026.09.myntra-ej-rate-cards-1';
const DB_CONNECTION_OPTIMIZATION_SCHEMA_VERSION = '2026.09.db-connection-optimization-1';

const TABLES = [`
  CREATE TABLE IF NOT EXISTS orders (
    id                      SERIAL PRIMARY KEY,
    order_id                TEXT,
    order_item_id           TEXT NOT NULL,
    fsn                     TEXT,
    sku                     TEXT,
    brand                   TEXT,
    selling_channel         TEXT,
    category                TEXT,
    hsn_code                TEXT,
    order_type              TEXT,
    fulfilment_type         TEXT,
    order_date              DATE,
    qty                     INT,
    final_invoice_amount    NUMERIC(14,2),
    total_share_amount      NUMERIC(14,2),
    my_share                NUMERIC(14,2),
    delivery_state          TEXT,
    delivery_city           TEXT,
    warehouse_id            TEXT,
    warehouse_city          TEXT,
    delivery_pincode        TEXT,
    vb_export_sku           TEXT,
    vb_export_category      TEXT,
    orders_status           TEXT,
    return_type             TEXT,
    weight_slab             TEXT,
    shipping_zone           TEXT,
    commission              NUMERIC(14,2),
    fixed_fee               NUMERIC(14,2),
    collection_fee          NUMERIC(14,2),
    pick_pack_fee           NUMERIC(14,2),
    shipping_fee            NUMERIC(14,2),
    reverse_shipping        NUMERIC(14,2),
    franchise               NUMERIC(14,2),
    customer_addon_recovery NUMERIC(14,2),
    tcs                     NUMERIC(14,2),
    tds                     NUMERIC(14,2),
    gst_on_mp               NUMERIC(14,2),
    settlement_amount       NUMERIC(14,2),
    return_received_amount  NUMERIC(14,2),
    spf_amount              NUMERIC(14,2),
    marketplace             TEXT DEFAULT 'flipkart',
    uploaded_at             TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT UQ_orders_item UNIQUE (order_item_id)
  )`,

  `CREATE TABLE IF NOT EXISTS returns (
    id                            SERIAL PRIMARY KEY,
    return_id                     TEXT,
    order_item_id                 TEXT NOT NULL,
    fulfilment_type               TEXT,
    return_requested_date         DATE,
    return_approval_date          DATE,
    return_status                 TEXT,
    return_reason                 TEXT,
    return_sub_reason             TEXT,
    return_type                   TEXT,
    return_result                 TEXT,
    return_expectation            TEXT,
    reverse_logistics_tracking_id TEXT,
    sku                           TEXT,
    fsn                           TEXT,
    product_title                 TEXT,
    quantity                      INT,
    return_completion_type        TEXT,
    primary_pv_output             TEXT,
    detailed_pv_output            TEXT,
    final_condition               TEXT,
    return_cancellation_reason    TEXT,
    tech_visit_sla                TEXT,
    tech_visit_by_date            DATE,
    tech_visit_completion_datetime TEXT,
    tech_visit_completion_breach  TEXT,
    return_completion_sla         TEXT,
    return_complete_by_date       DATE,
    return_completion_date        DATE,
    return_completion_breach      TEXT,
    return_cancellation_date      DATE,
    marketplace                   TEXT DEFAULT 'flipkart',
    uploaded_at                   TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT UQ_return_order_item UNIQUE (order_item_id)
  )`,

  `CREATE TABLE IF NOT EXISTS settlements (
    id                      SERIAL PRIMARY KEY,
    neft_id                 TEXT,
    neft_type               TEXT,
    payment_date            DATE,
    bank_settlement         NUMERIC(14,2),
    input_gst_tcs           NUMERIC(14,2),
    income_tax_credits      NUMERIC(14,2),
    order_id                TEXT,
    order_item_id           TEXT,
    sale_amount             NUMERIC(14,2),
    total_offer_amount      NUMERIC(14,2),
    my_share                NUMERIC(14,2),
    customer_addons         NUMERIC(14,2),
    marketplace_fee         NUMERIC(14,2),
    taxes                   NUMERIC(14,2),
    offer_adjustments       NUMERIC(14,2),
    protection_fund         NUMERIC(14,2),
    refund                  NUMERIC(14,2),
    tier                    TEXT,
    commission_rate         NUMERIC(10,6),
    commission              NUMERIC(14,2),
    fixed_fee               NUMERIC(14,2),
    collection_fee          NUMERIC(14,2),
    pick_pack_fee           NUMERIC(14,2),
    shipping_fee            NUMERIC(14,2),
    reverse_shipping        NUMERIC(14,2),
    customer_addon_recovery NUMERIC(14,2),
    franchise_fee           NUMERIC(14,2),
    tcs                     NUMERIC(14,2),
    tds                     NUMERIC(14,2),
    gst_on_mp_fees          NUMERIC(14,2),
    shipping_zone           TEXT,
    order_date              DATE,
    dispatch_date           DATE,
    marketplace             TEXT DEFAULT 'flipkart',
    uploaded_at             TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS statements (
    id          SERIAL PRIMARY KEY,
    month       TEXT NOT NULL,
    period      TEXT,
    description TEXT,
    credits     NUMERIC(14,2),
    debits      NUMERIC(14,2),
    net         NUMERIC(14,2),
    amount      NUMERIC(14,2),
    category    TEXT,
    pct         NUMERIC(10,6),
    uploaded_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS reconciliation_reports (
    id                SERIAL PRIMARY KEY,
    order_date        TEXT,
    order_item_id     TEXT,
    order_id          TEXT,
    category          TEXT,
    fulfilment_type   TEXT,
    delivery_state    TEXT,
    invoice_amount    NUMERIC(14,2),
    bank_received     NUMERIC(14,2),
    refund_debited    NUMERIC(14,2),
    net_settlement    NUMERIC(14,2),
    return_reason     TEXT,
    return_type       TEXT,
    settlement_status TEXT,
    report_generated  TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS upload_log (
    id            SERIAL PRIMARY KEY,
    data_type     TEXT,
    filename      TEXT,
    marketplace   TEXT DEFAULT 'flipkart',
    rows_inserted INT,
    rows_updated  INT,
    rows_skipped  INT,
    status        TEXT,
    error_msg     TEXT,
    remark        TEXT,
    data_cleared_at TIMESTAMPTZ,
    cleared_by      TEXT,
    cleared_by_email TEXT,
    clear_reason    TEXT,
    cleared_row_counts JSONB,
    uploaded_at   TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS upload_skipped_rows (
    id            SERIAL PRIMARY KEY,
    upload_log_id INTEGER,
    row_num       INTEGER,
    skip_reason   TEXT,
    raw_json      JSONB,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS charges_config (
    id           SERIAL PRIMARY KEY,
    key          TEXT NOT NULL UNIQUE,
    label        TEXT NOT NULL,
    category     TEXT NOT NULL DEFAULT 'marketplace_fee',
    source       TEXT NOT NULL DEFAULT 'data',
    enabled      BOOLEAN DEFAULT true,
    custom_type  TEXT,
    custom_value NUMERIC(14,4),
    sort_order   INT DEFAULT 0,
    updated_at   TIMESTAMPTZ DEFAULT NOW()
  )`,

  /* ── Rate Card tables ───────────────────────────────────────────────────── */
  `CREATE TABLE IF NOT EXISTS rc_commission (
    id         SERIAL PRIMARY KEY,
    category   TEXT NOT NULL,
    start_date DATE,
    end_date   DATE,
    price_min  NUMERIC(12,2) DEFAULT 0,
    price_max  NUMERIC(12,2) DEFAULT 999999,
    rate       NUMERIC(8,6)  NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS rc_fixed_fee (
    id              SERIAL PRIMARY KEY,
    category        TEXT NOT NULL,
    start_date      DATE,
    end_date        DATE,
    fulfilment_type TEXT DEFAULT 'ALL',
    price_min       NUMERIC(12,2) DEFAULT 0,
    price_max       NUMERIC(12,2) DEFAULT 999999,
    rate            NUMERIC(10,2) NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS rc_collection_fee (
    id         SERIAL PRIMARY KEY,
    category   TEXT NOT NULL,
    start_date DATE,
    end_date   DATE,
    price_min  NUMERIC(12,2) DEFAULT 0,
    price_max  NUMERIC(12,2) DEFAULT 999999,
    prepaid    NUMERIC(8,6)  DEFAULT 0,
    postpaid   NUMERIC(8,6)  DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS rc_pick_pack (
    id         SERIAL PRIMARY KEY,
    category   TEXT NOT NULL,
    start_date DATE,
    end_date   DATE,
    price_min  NUMERIC(12,2) DEFAULT 0,
    price_max  NUMERIC(12,2) DEFAULT 999999,
    rate       NUMERIC(10,2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS rc_reverse_shipping (
    id          SERIAL PRIMARY KEY,
    category    TEXT NOT NULL,
    start_date  DATE,
    end_date    DATE,
    price_min   NUMERIC(12,2) DEFAULT 0,
    price_max   NUMERIC(12,2) DEFAULT 999999,
    weight_slab TEXT,
    local_fee   NUMERIC(10,2) DEFAULT 0,
    zonal_fee   NUMERIC(10,2) DEFAULT 0,
    national_fee NUMERIC(10,2) DEFAULT 0,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS fk_settlement_orders (
    id                       SERIAL PRIMARY KEY,
    neft_id                  TEXT,
    neft_type                TEXT,
    payment_date             DATE,
    bank_settlement          NUMERIC(14,2),
    input_gst_tcs            NUMERIC(14,2),
    income_tax_credits       NUMERIC(14,2),
    order_id                 TEXT,
    order_item_id            TEXT,
    sale_amount              NUMERIC(14,2),
    total_offer_amount       NUMERIC(14,2),
    my_share                 NUMERIC(14,2),
    customer_addons          NUMERIC(14,2),
    marketplace_fee          NUMERIC(14,2),
    taxes                    NUMERIC(14,2),
    offer_adjustments        NUMERIC(14,2),
    protection_fund          NUMERIC(14,2),
    refund                   NUMERIC(14,2),
    tier                     TEXT,
    commission_rate          NUMERIC(10,6),
    commission               NUMERIC(14,2),
    fixed_fee                NUMERIC(14,2),
    collection_fee           NUMERIC(14,2),
    pick_pack_fee            NUMERIC(14,2),
    shipping_fee             NUMERIC(14,2),
    reverse_shipping         NUMERIC(14,2),
    no_cost_emi_fee          NUMERIC(14,2),
    installation_fee         NUMERIC(14,2),
    tech_visit_fee           NUMERIC(14,2),
    uninstallation_fee       NUMERIC(14,2),
    customer_addon_recovery  NUMERIC(14,2),
    franchise_fee            NUMERIC(14,2),
    shopsy_marketing_fee     NUMERIC(14,2),
    cancellation_fee         NUMERIC(14,2),
    tcs                      NUMERIC(14,2),
    tds                      NUMERIC(14,2),
    gst_on_mp_fees           NUMERIC(14,2),
    offer_amount_discount_mp NUMERIC(14,2),
    item_gst_rate            NUMERIC(10,4),
    discount_mp_fees         NUMERIC(14,2),
    gst_on_discount          NUMERIC(14,2),
    total_discount_mp_fee    NUMERIC(14,2),
    offer_adjustment_detail  NUMERIC(14,2),
    dead_weight              NUMERIC(10,4),
    dimensions               TEXT,
    volumetric_weight        NUMERIC(10,4),
    chargeable_weight_source TEXT,
    chargeable_weight_type   TEXT,
    chargeable_weight_slab   TEXT,
    shipping_zone            TEXT,
    order_date               DATE,
    dispatch_date            DATE,
    fulfilment_type          TEXT,
    seller_sku               TEXT,
    quantity                 INT,
    product_sub_category     TEXT,
    additional_info          TEXT,
    return_type              TEXT,
    shopsy_order             TEXT,
    item_return_status       TEXT,
    invoice_id               TEXT,
    invoice_date             DATE,
    marketplace              TEXT DEFAULT 'flipkart',
    uploaded_at              TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT UQ_fk_sett_neft_item UNIQUE (neft_id, order_item_id)
  )`,

  `CREATE TABLE IF NOT EXISTS fk_spf_claims (
    id                SERIAL PRIMARY KEY,
    neft_id           TEXT,
    payment_date      DATE,
    settlement_value  NUMERIC(14,2),
    claim_id          TEXT,
    order_item_id     TEXT,
    status            TEXT,
    protection_reason TEXT,
    seller_sku        TEXT,
    fsn               TEXT,
    selling_price     NUMERIC(14,2),
    warehouse_id      TEXT,
    marketplace       TEXT DEFAULT 'flipkart',
    uploaded_at       TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT UQ_fk_spf_claim_neft UNIQUE (claim_id, neft_id)
  )`,

  `CREATE TABLE IF NOT EXISTS return_tracking (
    id                 SERIAL PRIMARY KEY,
    order_item_id      TEXT NOT NULL,
    marketplace        TEXT DEFAULT 'flipkart',
    physical_condition TEXT,
    spf_status         TEXT,
    remarks            TEXT,
    updated_at         TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT UQ_return_tracking_item UNIQUE (order_item_id, marketplace)
  )`,

  `CREATE TABLE IF NOT EXISTS fk_storage_recall (
    id                       SERIAL PRIMARY KEY,
    neft_id                  TEXT,
    payment_date             DATE,
    settlement_value         NUMERIC(14,2),
    service_name             TEXT,
    listing_id               TEXT,
    recall_id                TEXT,
    warehouse_state          TEXT,
    fsn                      TEXT,
    marketplace_fees         NUMERIC(14,2),
    gst_fees                 NUMERIC(14,2),
    removal_fee_units        NUMERIC(10,4),
    removal_fee              NUMERIC(14,2),
    storage_fee_units        NUMERIC(10,4),
    storage_fee              NUMERIC(14,2),
    sellable_regular_units   NUMERIC(10,4),
    sellable_regular         NUMERIC(14,2),
    unsellable_regular_units NUMERIC(10,4),
    unsellable_regular       NUMERIC(14,2),
    product_sub_category     TEXT,
    dead_weight              NUMERIC(10,4),
    volumetric_weight        NUMERIC(10,4),
    chargeable_weight_slab   TEXT,
    marketplace              TEXT DEFAULT 'flipkart',
    uploaded_at              TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS fk_ads (
    id                     SERIAL PRIMARY KEY,
    neft_id                TEXT,
    payment_date           DATE,
    settlement_value       NUMERIC(14,2),
    transaction_type       TEXT,
    campaign_id            TEXT,
    wallet_redeem          NUMERIC(14,2),
    wallet_redeem_reversal NUMERIC(14,2),
    wallet_topup           NUMERIC(14,2),
    wallet_refund          NUMERIC(14,2),
    gst_on_ads             NUMERIC(14,2),
    marketplace            TEXT DEFAULT 'flipkart',
    uploaded_at            TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS fk_google_ads (
    id               SERIAL PRIMARY KEY,
    neft_id          TEXT,
    payment_date     DATE,
    settlement_value NUMERIC(14,2),
    service_name     TEXT,
    service_details  TEXT,
    service_order_id TEXT,
    purchase_date    DATE,
    total_amount     NUMERIC(14,2),
    service_amount   NUMERIC(14,2),
    gst_on_service   NUMERIC(14,2),
    marketplace      TEXT DEFAULT 'flipkart',
    uploaded_at      TIMESTAMPTZ DEFAULT NOW()
  )`,

  /* ── Amazon Settlement — raw V2 line items ─────────────────────────────────── */

  /* 💰 Meesho Settlement — raw multi-sheet items -------------------------------- */
  `CREATE TABLE IF NOT EXISTS meesho_settlement_items (
    id                   SERIAL PRIMARY KEY,
    settlement_id        TEXT,
    payment_date         DATE,
    order_item_id        TEXT,
    sku                  TEXT,
    transaction_type     TEXT,
    bank_settlement      NUMERIC(14,2),
    sale_amount          NUMERIC(14,2),
    commission_fee       NUMERIC(10,2),
    fixed_fee            NUMERIC(10,2),
    shipping_fee         NUMERIC(10,2),
    reverse_shipping     NUMERIC(10,2),
    other_fee            NUMERIC(10,2),
    tcs                  NUMERIC(10,2),
    tds                  NUMERIC(10,2),
    claims               NUMERIC(14,2),
    uploaded_at          TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS amazon_settlement_items (
    id                          SERIAL PRIMARY KEY,
    settlement_id               TEXT,
    settlement_start_date       DATE,
    settlement_end_date         DATE,
    deposit_date                DATE,
    total_amount                NUMERIC(14,2),
    currency                    TEXT DEFAULT 'INR',
    transaction_type            TEXT,
    order_id                    TEXT,
    merchant_order_id           TEXT,
    adjustment_id               TEXT,
    shipment_id                 TEXT,
    marketplace_name            TEXT,
    shipment_fee_type           TEXT,
    shipment_fee_amount         NUMERIC(14,2),
    order_fee_type              TEXT,
    order_fee_amount            NUMERIC(14,2),
    fulfillment_id              TEXT,
    posted_date                 DATE,
    order_item_code             TEXT,
    merchant_order_item_id      TEXT,
    sku                         TEXT,
    quantity_purchased          INT,
    price_type                  TEXT,
    price_amount                NUMERIC(14,2),
    item_related_fee_type       TEXT,
    item_related_fee_amount     NUMERIC(14,2),
    uploaded_at                 TIMESTAMPTZ DEFAULT NOW()
  )`,

  /* ── SKU Master — maps marketplace listing SKUs to master SKUs + COGS ──────── */
  `CREATE TABLE IF NOT EXISTS sku_master (
    id          SERIAL PRIMARY KEY,
    master_sku  TEXT NOT NULL,
    marketplace TEXT NOT NULL DEFAULT 'all',
    listing_sku TEXT NOT NULL,
    cogs        NUMERIC(14,2) NOT NULL DEFAULT 0,
    category    TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(marketplace, listing_sku)
  )`,

  /* ── VB Export Master SKU — parent catalog level metadata, COGS & Weight Slabs ── */
  `CREATE TABLE IF NOT EXISTS vb_sku_master (
    vb_export_sku TEXT PRIMARY KEY,
    category      TEXT,
    cogs          NUMERIC(14,2) NOT NULL DEFAULT 0,
    weight_slab   NUMERIC(6,2),
    product_name  TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS catalog_cogs (
    id           SERIAL PRIMARY KEY,
    marketplace  TEXT NOT NULL DEFAULT 'all',
    catalog_id   TEXT NOT NULL,
    category     TEXT,
    cogs         NUMERIC(14,2) NOT NULL DEFAULT 0,
    product_name TEXT,
    brand_name   TEXT,
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(marketplace, catalog_id)
  )`,

  /* ── Users — stores credentialed accounts and access levels ────────────────── */
  `CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      TEXT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    role          TEXT DEFAULT 'viewer',
    firebase_uid  TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS audit_events (
    id            BIGSERIAL PRIMARY KEY,
    actor_user_id INTEGER,
    actor_email   TEXT,
    actor_role    TEXT,
    action        TEXT NOT NULL,
    entity_type   TEXT,
    entity_id     TEXT,
    details       JSONB DEFAULT '{}'::jsonb,
    ip_address    TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS rate_card_versions (
    id              BIGSERIAL PRIMARY KEY,
    marketplace     TEXT NOT NULL DEFAULT 'flipkart',
    seller_account  TEXT NOT NULL DEFAULT 'default',
    version_name    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'draft',
    effective_from  DATE,
    effective_to    DATE,
    snapshot        JSONB NOT NULL,
    created_by      INTEGER,
    published_by    INTEGER,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    published_at    TIMESTAMPTZ,
    CONSTRAINT ck_rate_card_version_status CHECK (status IN ('draft','published','archived'))
  )`,

  /* Delivery record for rate-card change emails. A successful Resend API
     request means accepted by Resend; final mailbox delivery/open events need
     a Resend webhook and are deliberately not inferred here. */
  `CREATE TABLE IF NOT EXISTS rate_card_notification_log (
    id                  BIGSERIAL PRIMARY KEY,
    event_type          TEXT NOT NULL,
    recipient           TEXT NOT NULL,
    subject             TEXT NOT NULL,
    payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
    status              TEXT NOT NULL DEFAULT 'queued',
    provider_message_id TEXT,
    error_message       TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    sent_at             TIMESTAMPTZ
  )`,

  /* Amazon expected-charge rules.  Raw settlement lines remain unchanged;
     these are only the seller's verified commercial terms used for comparison.
     We intentionally do not seed public/default Amazon rates. */
  `CREATE TABLE IF NOT EXISTS amazon_rate_card_rules (
    id                  BIGSERIAL PRIMARY KEY,
    seller_account      TEXT NOT NULL DEFAULT 'default',
    fee_code            TEXT NOT NULL,
    program             TEXT NOT NULL DEFAULT 'ALL',
    category            TEXT NOT NULL DEFAULT 'ALL',
    brand_name          TEXT,
    weight_slab         TEXT,
    start_date          DATE,
    end_date            DATE,
    price_min           NUMERIC(12,2) NOT NULL DEFAULT 0,
    price_max           NUMERIC(12,2) NOT NULL DEFAULT 999999,
    calculation_basis   TEXT NOT NULL DEFAULT 'per_unit',
    rate                NUMERIC(14,6) NOT NULL,
    tax_rate            NUMERIC(8,6) NOT NULL DEFAULT 0.18,
    priority            INTEGER NOT NULL DEFAULT 0,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_amazon_rule_program CHECK (program IN ('ALL','FBA','FLEX')),
    CONSTRAINT ck_amazon_rule_basis CHECK (calculation_basis IN ('per_order_line','per_unit','percent_of_sale')),
    CONSTRAINT ck_amazon_rule_price_range CHECK (price_max >= price_min),
    CONSTRAINT ck_amazon_rule_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
  )`,

  `CREATE TABLE IF NOT EXISTS exception_resolutions (
    exception_key TEXT PRIMARY KEY,
    status        TEXT NOT NULL DEFAULT 'open',
    note          TEXT,
    resolved_by   INTEGER,
    resolved_at   TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  )`,

  /* One claim can exist for each fee type on an order item.  The rate-audit
     screens already use this table; declaring it here makes a fresh database
     safe instead of leaving the dispute workflow dependent on old state. */
  `CREATE TABLE IF NOT EXISTS fee_disputes (
    id              SERIAL PRIMARY KEY,
    order_item_id   TEXT NOT NULL,
    fee_type        TEXT NOT NULL,
    expected_amount NUMERIC(14,2),
    actual_amount   NUMERIC(14,2),
    dispute_status  TEXT NOT NULL DEFAULT 'open',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_fee_disputes_item_fee UNIQUE (order_item_id, fee_type)
  )`,
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS IX_settlements_order_item ON settlements(order_item_id)`,
  `CREATE INDEX IF NOT EXISTS IX_settlements_order_id  ON settlements(order_id)`,
  `CREATE INDEX IF NOT EXISTS IX_settlements_payment_date ON settlements(payment_date)`,
  `CREATE INDEX IF NOT EXISTS IX_skipped_log ON upload_skipped_rows(upload_log_id)`,
  `CREATE INDEX IF NOT EXISTS IX_upload_log_history ON upload_log(uploaded_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS IX_upload_log_market_history ON upload_log(marketplace, uploaded_at DESC)`,
  `CREATE INDEX IF NOT EXISTS IX_upload_log_type_history ON upload_log(data_type, uploaded_at DESC)`,
  `CREATE INDEX IF NOT EXISTS IX_upload_log_cleared_history ON upload_log(data_cleared_at DESC, uploaded_at DESC)`,
  `CREATE INDEX IF NOT EXISTS IX_amzn_sett_order   ON amazon_settlement_items(order_id)`,
  `CREATE INDEX IF NOT EXISTS IX_amzn_sett_deposit  ON amazon_settlement_items(deposit_date)`,
  `CREATE INDEX IF NOT EXISTS IX_amzn_sett_sett_id  ON amazon_settlement_items(settlement_id)`,
  `CREATE INDEX IF NOT EXISTS IX_sku_master_listing ON sku_master(marketplace, listing_sku)`,
  `CREATE INDEX IF NOT EXISTS IX_sku_master_master  ON sku_master(master_sku)`,
  `CREATE INDEX IF NOT EXISTS IX_sku_master_category ON sku_master(category)`,
  `CREATE INDEX IF NOT EXISTS IX_vb_sku_master_category ON vb_sku_master(category)`,
  `CREATE INDEX IF NOT EXISTS IX_orders_vb_export_sku ON orders(vb_export_sku)`,
  `CREATE INDEX IF NOT EXISTS IX_orders_vb_export_cat ON orders(vb_export_category)`,
  `CREATE INDEX IF NOT EXISTS IX_catalog_cogs_lookup ON catalog_cogs(marketplace, catalog_id)`,
  `CREATE INDEX IF NOT EXISTS IX_audit_created ON audit_events(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS IX_audit_actor ON audit_events(actor_user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS IX_rate_versions_scope ON rate_card_versions(marketplace, seller_account, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS IX_rate_card_notification_log_created ON rate_card_notification_log(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS IX_amazon_rate_rules_match ON amazon_rate_card_rules(seller_account, fee_code, program, is_active, start_date DESC)`,
  `CREATE INDEX IF NOT EXISTS IX_orders_date_cat   ON orders(order_date, category, delivery_state, orders_status)`,
  /* Dashboard filters always start with marketplace and a time range. */
  `CREATE INDEX IF NOT EXISTS IX_orders_market_date ON orders(marketplace, order_date DESC)`,
  `CREATE INDEX IF NOT EXISTS IX_orders_market_order_sku ON orders(marketplace, order_id, sku)`,
  `CREATE INDEX IF NOT EXISTS IX_returns_item       ON returns(order_item_id)`,
  `CREATE INDEX IF NOT EXISTS IX_returns_market_requested ON returns(marketplace, return_requested_date DESC)`,
  `CREATE INDEX IF NOT EXISTS IX_returns_market_order_sku ON returns(marketplace, order_id, sku)`,
  `CREATE INDEX IF NOT EXISTS IX_meesho_item ON meesho_settlement_items(order_item_id)`,
  `CREATE INDEX IF NOT EXISTS IX_meesho_date ON meesho_settlement_items(payment_date)`,
  `CREATE INDEX IF NOT EXISTS IX_fko_item           ON fk_settlement_orders(order_item_id)`,
  `CREATE INDEX IF NOT EXISTS IX_fko_payment_date   ON fk_settlement_orders(payment_date)`,
  `CREATE INDEX IF NOT EXISTS IX_fko_market_payment ON fk_settlement_orders(marketplace, payment_date DESC)`,
  `CREATE INDEX IF NOT EXISTS IX_fko_neft_id        ON fk_settlement_orders(neft_id)`,
  `CREATE INDEX IF NOT EXISTS IX_spf_neft_id        ON fk_spf_claims(neft_id)`,
  `CREATE INDEX IF NOT EXISTS IX_storage_neft_id    ON fk_storage_recall(neft_id)`,
  `CREATE INDEX IF NOT EXISTS IX_ads_neft_id        ON fk_ads(neft_id)`,
  `CREATE INDEX IF NOT EXISTS IX_gadss_neft_id      ON fk_google_ads(neft_id)`,
];

export async function initDb() {
  if (!(await isDbConfigured())) {
    console.log('[db] PostgreSQL not configured — skipping schema init');
    return;
  }
  try {
    const pool = getPool();

    // schema_version is deliberately created before the rest of the schema so
    // established installations can skip startup DDL entirely. On a fresh or
    // older database the full migration below still runs once as before.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id SERIAL PRIMARY KEY,
        version TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    const { rowCount: alreadyCurrent } = await pool.query(
      `SELECT 1 FROM schema_version WHERE version = $1 LIMIT 1`,
      [CURRENT_SCHEMA_VERSION],
    );
    if (alreadyCurrent) {
      await ensureMyntraUploadSchema(pool);
      await ensureMyntraSellerIdSchema(pool);
      await ensureUploadAuditRetentionSchema(pool);
      await ensureNormalizedRateCardSchema(pool);
      await ensureMpInvoiceIdempotencySchema(pool);
      await ensureMpLedgerIdempotencySchema(pool);
      await ensureMyntraPaymentLinkageSchema(pool);
      await ensureMyntraOrderTypeSchema(pool);
      await ensureMyntraItemizedFeesSchema(pool);
      await ensureMyntraRtoReturnDateFix(pool);
      await ensureMyntraPartnerWarehouseSchema(pool);
      await ensureMyntraBlankTrackingRtoFix(pool);
      await ensureMyntraBlankTrackingCancelledFix(pool);
      await ensureMyntraEjRateCardsSeed(pool);
      await ensureDbConnectionOptimization(pool);
      // A read-model migration changes the view definition as well as the
      // backing table, so it must run on already-current installations too.
      await ensureAmazonSettlementReportingRollups(pool);
      await ensureUnifiedSettlementsView(pool);
      await ensureOrderSettlementTotals(pool);
      console.log(`[db] Schema ${CURRENT_SCHEMA_VERSION} already ready; skipping startup DDL.`);
      return;
    }

    for (const ddl of TABLES)   { await pool.query(ddl); }
    for (const ddl of INDEXES)  { await pool.query(ddl); }
    
    // Column migrations – safe to run on existing tables
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS brand TEXT`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS return_cancellation_reason TEXT`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS tech_visit_sla TEXT`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS tech_visit_by_date DATE`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS tech_visit_completion_datetime TEXT`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS tech_visit_completion_breach TEXT`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS return_completion_sla TEXT`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS return_complete_by_date DATE`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS return_completion_date DATE`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS return_completion_breach TEXT`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS return_cancellation_date DATE`);

    await pool.query(`ALTER TABLE upload_skipped_rows ADD COLUMN IF NOT EXISTS skip_reason TEXT`).catch(() => {});
    // Key migration: returns now keyed by order_item_id, not return_id
    await pool.query(`ALTER TABLE returns ALTER COLUMN return_id DROP NOT NULL`).catch(() => {});
    await pool.query(`ALTER TABLE returns DROP CONSTRAINT IF EXISTS uq_return_id`).catch(() => {});
    await pool.query(`ALTER TABLE returns DROP CONSTRAINT IF EXISTS "UQ_return_id"`).catch(() => {});
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uq_return_order_item' AND conrelid = 'returns'::regclass
        ) THEN
          ALTER TABLE returns ADD CONSTRAINT uq_return_order_item UNIQUE (order_item_id);
        END IF;
      END $$
    `).catch(e => console.warn('[db] returns constraint migration:', e.message));

    // RC table migrations — add marketplace column so rates are scoped per marketplace
    for (const t of ['rc_commission','rc_fixed_fee','rc_collection_fee','rc_pick_pack','rc_reverse_shipping']) {
      await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS marketplace TEXT NOT NULL DEFAULT 'flipkart'`).catch(() => {});
    }
    // Collection fee: mixed flat-₹ / % per slab + FBF vs Non-FBF fulfilment distinction
    await pool.query(`ALTER TABLE rc_collection_fee ADD COLUMN IF NOT EXISTS fulfilment_type TEXT DEFAULT 'All'`).catch(() => {});
    // Pick & Pack: add fulfilment_type so FBA vs Flex can have different rates (Amazon)
    await pool.query(`ALTER TABLE rc_pick_pack ADD COLUMN IF NOT EXISTS fulfilment_type TEXT NOT NULL DEFAULT 'ALL'`).catch(() => {});
    await pool.query(`ALTER TABLE rc_collection_fee ADD COLUMN IF NOT EXISTS prepaid_type    TEXT DEFAULT 'pct'`).catch(() => {});
    await pool.query(`ALTER TABLE rc_collection_fee ADD COLUMN IF NOT EXISTS postpaid_type   TEXT DEFAULT 'pct'`).catch(() => {});
    // seller_account — scopes rate cards per seller account / brand (e.g. Myntra brand names)
    for (const t of ['rc_commission','rc_fixed_fee','rc_collection_fee','rc_pick_pack','rc_reverse_shipping']) {
      await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS seller_account TEXT NOT NULL DEFAULT 'default'`).catch(() => {});
    }
    // Reverse shipping is rate-carded by both order item value and weight.
    // Existing rows retain their previous behaviour through this unrestricted range.
    await pool.query(`ALTER TABLE rc_reverse_shipping ADD COLUMN IF NOT EXISTS price_min NUMERIC(12,2) NOT NULL DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE rc_reverse_shipping ADD COLUMN IF NOT EXISTS price_max NUMERIC(12,2) NOT NULL DEFAULT 999999`).catch(() => {});
    await pool.query(`ALTER TABLE users ALTER COLUMN role SET DEFAULT 'viewer'`).catch(() => {});
    await pool.query(`UPDATE users SET role = 'operator' WHERE role = 'user'`).catch(() => {});
    // seller_account on orders — identifies which brand/account an order belongs to (Myntra brand etc.)
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS seller_account TEXT NOT NULL DEFAULT 'default'`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_orders_market_account_date ON orders(marketplace, seller_account, order_date DESC)`).catch(() => {});
    // marketplace_accounts — stores named accounts/brands per marketplace
    await pool.query(`
      CREATE TABLE IF NOT EXISTS marketplace_accounts (
        id           SERIAL PRIMARY KEY,
        marketplace  TEXT NOT NULL,
        account_id   TEXT NOT NULL,
        display_name TEXT NOT NULL,
        is_active    BOOLEAN DEFAULT true,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(marketplace, account_id)
      )
    `).catch(() => {});
    // Seed one default account per marketplace. Myntra is deliberately split
    // into its two operating accounts below; its legacy default stays only for
    // old data and is deactivated once it no longer contains invoice rows.
    for (const [mp, name] of [['flipkart','Flipkart'],['amazon','Amazon'],['myntra','Myntra'],['meesho','Meesho'],['jiomart','JioMart']]) {
      await pool.query(
        `INSERT INTO marketplace_accounts (marketplace, account_id, display_name) VALUES ($1,'default',$2) ON CONFLICT DO NOTHING`,
        [mp, name]
      ).catch(() => {});
    }
    for (const [accountId, displayName] of [
      ['myntra_vb', 'Myntra (VB)'],
      ['myntra_ej', 'Myntra (EJ)'],
    ]) {
      await pool.query(
        `INSERT INTO marketplace_accounts (marketplace, account_id, display_name)
         VALUES ('myntra', $1, $2)
         ON CONFLICT (marketplace, account_id)
         DO UPDATE SET display_name = EXCLUDED.display_name, is_active = TRUE`,
        [accountId, displayName]
      ).catch(() => {});
    }
    // Seed default charges_config entries (ON CONFLICT DO NOTHING preserves user customizations)
    const DEFAULT_CHARGES = [
      ['commission',              'Commission',                    'marketplace_fee',  0],
      ['fixed_fee',               'Fixed Fee',                     'marketplace_fee',  1],
      ['collection_fee',          'Collection Fee',                'marketplace_fee',  2],
      ['pick_pack_fee',           'Pick & Pack Fee',               'marketplace_fee',  3],
      ['shipping_fee',            'Shipping Fee',                  'logistics',        4],
      ['reverse_shipping',        'Reverse Shipping',              'logistics',        5],
      ['franchise_fee',           'Franchise Fee',                 'marketplace_fee',  6],
      ['customer_addon_recovery', 'Customer Addon Recovery',       'marketplace_fee',  7],
      ['no_cost_emi',             'No Cost EMI Fee',               'marketplace_fee',  8],
      ['shopsy_marketing',        'Shopsy Marketing Fee',          'marketplace_fee',  9],
      ['cancellation_fee',        'Cancellation Fee',              'marketplace_fee', 10],
      ['tcs',                     'TCS (Tax Collected at Source)', 'tax',             11],
      ['tds',                     'TDS (Tax Deducted at Source)',  'tax',             12],
      ['gst_on_mp_fees',          'GST on MP Fees',                'tax',             13],
      ['fk_ads',                  'Flipkart Ads Spend',            'ads',             14],
      ['fk_storage',              'Storage & Recall Fees',         'storage',         15],
    ];
    for (const [key, label, category, sortOrder] of DEFAULT_CHARGES) {
      await pool.query(
        `INSERT INTO charges_config (key, label, category, source, sort_order)
         VALUES ($1,$2,$3,'data',$4) ON CONFLICT (key) DO NOTHING`,
        [key, label, category, sortOrder]
      );
    }

    // SKU master — add lifecycle fields (safe on existing tables)
    await pool.query(`ALTER TABLE sku_master ADD COLUMN IF NOT EXISTS launch_date DATE`).catch(() => {});
    await pool.query(`ALTER TABLE sku_master ADD COLUMN IF NOT EXISTS product_name TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE sku_master ADD COLUMN IF NOT EXISTS weight_slab NUMERIC(6,2)`).catch(() => {});
    // SKU master — brand_name: master brand column, backfills orders.brand_name automatically
    await pool.query(`ALTER TABLE sku_master ADD COLUMN IF NOT EXISTS brand_name TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE sku_master ADD COLUMN IF NOT EXISTS category TEXT`).catch(() => {});

    // Orders — add vb_export_sku and vb_export_category
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS vb_export_sku TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS vb_export_category TEXT`).catch(() => {});

    // Returns — add return_date column (used by Amazon returns report)
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS return_date DATE`).catch(() => {});

    // Orders — add brand_name (mapped from 'Brand' column in FK/Amazon order report)
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS brand_name TEXT`).catch(() => {});
    // Amazon is a single-brand account. Apply the business identity at the
    // canonical order layer so every dashboard and rate comparison agrees.
    await pool.query(`
      UPDATE orders
      SET brand_name = $1, brand = $1
      WHERE marketplace = 'amazon'
        AND (brand_name IS DISTINCT FROM $1 OR brand IS DISTINCT FROM $1)
    `, [AMAZON_BRAND]).catch(e => console.warn('[db] Amazon brand backfill:', e.message));

    // RC commission — brand-specific rates: brand_name NULL = applies to all brands (fallback)
    await pool.query(`ALTER TABLE rc_commission ADD COLUMN IF NOT EXISTS brand_name TEXT DEFAULT NULL`).catch(() => {});

    // Franchise fee rate card table (FK charges flat ₹/order for certain brands/categories)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rc_franchise_fee (
        id             SERIAL PRIMARY KEY,
        category       TEXT NOT NULL DEFAULT 'ALL',
        brand_name     TEXT DEFAULT NULL,
        marketplace    TEXT NOT NULL DEFAULT 'flipkart',
        seller_account TEXT NOT NULL DEFAULT 'default',
        start_date     DATE,
        end_date       DATE,
        price_min      NUMERIC(12,2) DEFAULT 0,
        price_max      NUMERIC(12,2) DEFAULT 999999,
        rate           NUMERIC(10,2) NOT NULL DEFAULT 0,
        updated_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Migration: add SPF received tracking columns
    await pool.query(`ALTER TABLE fk_settlement_orders ADD COLUMN IF NOT EXISTS spf_received BOOLEAN DEFAULT FALSE`).catch(() => {});
    await pool.query(`ALTER TABLE fk_settlement_orders ADD COLUMN IF NOT EXISTS spf_received_date DATE`).catch(() => {});
    await pool.query(`ALTER TABLE fk_settlement_orders ADD COLUMN IF NOT EXISTS spf_received_amount NUMERIC(14,2) DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE fk_settlement_orders ADD COLUMN IF NOT EXISTS spf_received_neft_id TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS is_received BOOLEAN DEFAULT FALSE`).catch(() => {});
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS received_date DATE`).catch(() => {});
      await pool.query(`ALTER TABLE meesho_settlement_items ADD COLUMN IF NOT EXISTS reverse_shipping NUMERIC(10,2) DEFAULT 0`).catch(() => {});

    // order_spf_tracking: track SPF received vs not received per order
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_spf_tracking (
        id SERIAL PRIMARY KEY,
        order_item_id TEXT NOT NULL,
        spf_deducted NUMERIC(14,2) DEFAULT 0,
        spf_received BOOLEAN DEFAULT FALSE,
        spf_received_date DATE,
        spf_received_amount NUMERIC(14,2) DEFAULT 0,
        spf_claim_id TEXT,
        neft_id TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_spf_order UNIQUE (order_item_id)
      )
    `).catch(() => {});

    // ── Multi-marketplace settlement ─────────────────────────────────────────
    // mp_config: registry of all marketplaces + their reconciliation type
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mp_config (
        marketplace   VARCHAR(50)  PRIMARY KEY,
        display_name  VARCHAR(100) NOT NULL,
        reco_type     VARCHAR(20)  NOT NULL DEFAULT 'order',  -- order | invoice | ledger
        is_active     BOOLEAN      DEFAULT TRUE,
        color         VARCHAR(20)  DEFAULT 'slate',
        notes         TEXT,
        created_at    TIMESTAMPTZ  DEFAULT NOW()
      )
    `).catch(() => {});

    // Seed known marketplaces (idempotent)
    await pool.query(`
      INSERT INTO mp_config (marketplace, display_name, reco_type, color) VALUES
        ('flipkart',  'Flipkart',    'order',   'indigo'),
        ('shopsy',    'Shopsy',      'order',   'violet'),
        ('amazon',    'Amazon',      'order',   'amber'),
        ('myntra',    'Myntra SOR',  'invoice', 'rose'),
        ('meesho',    'Meesho',      'order',   'emerald'),
        ('zepto',     'Zepto',       'ledger',  'emerald'),
        ('cocoblue',  'Cocoblue',    'invoice', 'sky')
      ON CONFLICT (marketplace) DO NOTHING
    `).catch(() => {});

    // mp_invoices: invoice-based reconciliation (Myntra SOR, Cocoblue, etc.)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mp_invoices (
        id                  SERIAL PRIMARY KEY,
        marketplace         VARCHAR(50)  NOT NULL,
        seller_account      VARCHAR(100) DEFAULT 'default',
        invoice_number      VARCHAR(100),
        invoice_date        DATE,
        dispatch_date       DATE,
        sku                 TEXT,
        product_title       TEXT,
        quantity            INTEGER      DEFAULT 1,
        mrp                 NUMERIC(14,2) DEFAULT 0,
        selling_price       NUMERIC(14,2) DEFAULT 0,
        invoice_amount      NUMERIC(14,2) DEFAULT 0,
        commission_pct      NUMERIC(8,4)  DEFAULT 0,
        commission_amount   NUMERIC(14,2) DEFAULT 0,
        tds_pct             NUMERIC(8,4)  DEFAULT 0,
        tds_amount          NUMERIC(14,2) DEFAULT 0,
        other_deductions    NUMERIC(14,2) DEFAULT 0,
        net_payable         NUMERIC(14,2) DEFAULT 0,
        amount_received     NUMERIC(14,2) DEFAULT 0,
        payment_date        DATE,
        payment_reference   TEXT,
        order_release_id     TEXT,
        order_line_id        TEXT,
        return_id            TEXT,
        order_type           TEXT,
        tcs_amount           NUMERIC(14,2),
        fixed_fee_amount     NUMERIC(14,2),
        shipping_fee_amount  NUMERIC(14,2),
        pick_pack_fee_amount NUMERIC(14,2),
        gateway_fee_amount   NUMERIC(14,2),
        gst_on_mp_fees       NUMERIC(14,2),
        source_fingerprint  TEXT,
        status              VARCHAR(30)   DEFAULT 'Pending',
        notes               TEXT,
        upload_batch        VARCHAR(100),
        created_at          TIMESTAMPTZ   DEFAULT NOW(),
        updated_at          TIMESTAMPTZ   DEFAULT NOW()
      )
    `).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_mp_inv_mp    ON mp_invoices(marketplace)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_mp_inv_date  ON mp_invoices(invoice_date)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_mp_inv_sku   ON mp_invoices(sku)`).catch(() => {});
    // The account is always selected before a Myntra import. These composite
    // indexes keep account-specific payment checks from reading the other
    // account's rows as the invoice table grows.
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_mp_inv_market_account_date ON mp_invoices(marketplace, seller_account, invoice_date DESC)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_mp_inv_market_account_status ON mp_invoices(marketplace, seller_account, status)`).catch(() => {});
    // Settlement benchmark reads only Paid rows for two months at a time.
    // This partial index avoids scanning an account's historical open invoices
    // as imported payment data grows.
    await pool.query(`
      CREATE INDEX IF NOT EXISTS IX_mp_inv_benchmark_paid
      ON mp_invoices (marketplace, payment_date DESC, seller_account, sku)
      WHERE payment_date IS NOT NULL
        AND amount_received > 0
        AND LOWER(TRIM(COALESCE(status, ''))) = 'paid'
        AND NULLIF(TRIM(sku), '') IS NOT NULL
    `).catch(() => {});
    // Do not hide an existing legacy account that still owns data. New Myntra
    // imports must use VB or EJ, so a clean database exposes only those two.
    await pool.query(`
      UPDATE marketplace_accounts account
      SET is_active = FALSE
      WHERE account.marketplace = 'myntra'
        AND account.account_id = 'default'
        AND NOT EXISTS (
          SELECT 1
          FROM mp_invoices invoice
          WHERE invoice.marketplace = 'myntra'
            AND invoice.seller_account = 'default'
        )
    `).catch(() => {});

    // mp_ledger_entries: ledger-based reconciliation (Zepto, etc.)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mp_ledger_entries (
        id               SERIAL PRIMARY KEY,
        marketplace      VARCHAR(50)  NOT NULL,
        seller_account   VARCHAR(100) DEFAULT 'default',
        entry_date       DATE         NOT NULL,
        reference_number VARCHAR(100),
        order_id         TEXT,
        description      TEXT,
        entry_type       VARCHAR(50)  DEFAULT 'Other',
        debit            NUMERIC(14,2) DEFAULT 0,
        credit           NUMERIC(14,2) DEFAULT 0,
        running_balance  NUMERIC(14,2),
        is_reconciled    BOOLEAN       DEFAULT FALSE,
        notes            TEXT,
        upload_batch     VARCHAR(100),
        source_fingerprint TEXT,
        created_at       TIMESTAMPTZ   DEFAULT NOW(),
        updated_at       TIMESTAMPTZ   DEFAULT NOW()
      )
    `).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_mp_led_mp    ON mp_ledger_entries(marketplace)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_mp_led_date  ON mp_ledger_entries(entry_date)`).catch(() => {});

    // returns_received: track received returns upload
    await pool.query(`
      CREATE TABLE IF NOT EXISTS returns_received (
        id SERIAL PRIMARY KEY,
        order_item_id TEXT NOT NULL,
        received_date DATE NOT NULL,
        is_bad_return BOOLEAN DEFAULT FALSE,
        notes TEXT,
        marketplace TEXT DEFAULT 'flipkart',
        uploaded_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_returns_received_order UNIQUE (order_item_id)
      )
    `).catch(() => {});

    // Data cleanup: round floating-point noise in rc_commission.rate to exactly 0
    // (AI image parser occasionally saves -0.0007 instead of 0.000000)
    // Threshold 0.005 = 0.5% — no legitimate commission rate exists below 1%
    await pool.query(
      `UPDATE rc_commission SET rate = 0.000000 WHERE ABS(rate) < 0.005 AND rate <> 0`
    ).catch(() => {});

    // ── Amazon multi-source linkage (June 2026) ────────────────────────────────
    // orders: extra columns sourced from "Order Reports" + "Order Summary" files
    const ORDER_COLS = [
      ['fnsku',                   'TEXT'],
      ['selling_zone',            'TEXT'],          // Local / Regional / National (origin zone from Order Summary)
      ['composite_key',           'TEXT'],          // AMZ-{order_id}-{seller_sku} — joins returns when real order_item_id missing
      ['merchant_order_id',       'TEXT'],
      ['item_tax',                'NUMERIC(14,2)'], // line-level tax (Order Reports)
      ['shipping_tax',            'NUMERIC(14,2)'],
      ['item_promotion_discount', 'NUMERIC(14,2)'],
      ['ship_promotion_discount', 'NUMERIC(14,2)'],
      ['gift_wrap_price',         'NUMERIC(14,2)'],
      ['gift_wrap_tax',           'NUMERIC(14,2)'],
      ['order_status',            'TEXT'],          // Order Reports: Pending / Shipped / Canceled
      ['item_status',             'TEXT'],
      ['is_business_order',       'BOOLEAN'],
      ['is_replacement_order',    'BOOLEAN'],
      ['is_exchange_order',       'BOOLEAN'],
      ['original_order_id',       'TEXT'],
      ['is_iba',                  'BOOLEAN'],
      ['purchase_order_number',   'TEXT'],
      ['price_designation',       'TEXT'],
      ['promotion_ids',           'TEXT'],
      ['ship_service_level',      'TEXT'],
      ['last_updated_date',       'TIMESTAMPTZ'],
      ['purchase_date_time',      'TIMESTAMPTZ'],   // full precision of purchase-date from Order Reports
      ['ship_country',            'TEXT'],
      ['ship_from_state',         'TEXT'],          // origin state from Order Summary
      ['ship_from_city',          'TEXT'],
      ['product_name',            'TEXT'],
      ['url',                     'TEXT'],
      ['order_channel',           'TEXT'],
      ['fulfilled_by',            'TEXT'],
      ['currency',                'TEXT'],
      ['product_amount',          'NUMERIC(14,2)'], // Sale Order export: Product Amount
      ['sale_shipping_amount',    'NUMERIC(14,2)'], // customer-paid shipping revenue
      ['sale_gift_amount',        'NUMERIC(14,2)'], // customer-paid gift-wrap revenue
    ];
    for (const [col, type] of ORDER_COLS) {
      await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${col} ${type}`).catch(() => {});
    }
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_orders_composite ON orders(composite_key)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_orders_order_id  ON orders(order_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_orders_sku       ON orders(sku)`).catch(() => {});

    // returns: extra columns sourced from FBA and Flex return reports
    const RETURN_COLS = [
      ['fnsku',                      'TEXT'],
      ['order_id',                   'TEXT'],
      ['composite_key',              'TEXT'],          // AMZ-{order_id}-{seller_sku} — joins to orders
      ['shipment_id',                'TEXT'],          // Flex
      ['carrier',                    'TEXT'],          // Flex: ATSPL / DELHIVERY / etc.
      ['forward_tracking_id',        'TEXT'],          // Flex
      ['days_in_transit',            'INT'],           // Flex
      ['days_since_return_complete', 'INT'],           // Flex
      ['returned_with_otp',          'BOOLEAN'],       // Flex
      ['customer_comment',           'TEXT'],          // FBA: customer-comments
      ['license_plate_number',       'TEXT'],          // FBA: physical return barcode (used as return_id)
      ['rma_id',                     'TEXT'],          // Flex: used as return_id
      ['disposition',                'TEXT'],          // FBA: SELLABLE/DEFECTIVE/etc.
      ['warehouse_id',               'TEXT'],          // FBA: fulfillment-center-id
      ['return_date_time',           'TIMESTAMPTZ'],   // FBA: full ISO 8601 timestamp
      ['units',                      'INT'],           // alias for quantity (Flex)
      ['asin',                       'TEXT'],          // for cross-reference (separate from fsn=ASIN per FK semantics)
    ];
    for (const [col, type] of RETURN_COLS) {
      await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS ${col} ${type}`).catch(() => {});
    }
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_returns_composite ON returns(composite_key)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_returns_order_id  ON returns(order_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_returns_order_sku ON returns(order_id, sku)`).catch(() => {});

    // sku_master: cross-link Amazon identifiers (fnsku + asin) so FBA returns
    // (which carry seller SKU directly) and other sources can resolve via FNSKU/ASIN.
    await pool.query(`ALTER TABLE sku_master ADD COLUMN IF NOT EXISTS fnsku TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE sku_master ADD COLUMN IF NOT EXISTS asin  TEXT`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_sku_master_fnsku ON sku_master(fnsku)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_sku_master_asin  ON sku_master(asin)`).catch(() => {});

    // ── Amazon FC Master ───────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS amazon_fc_master (
        fc_code VARCHAR(50) PRIMARY KEY,
        city VARCHAR(100),
        state VARCHAR(100),
        fc_type VARCHAR(50) DEFAULT 'FBA'
      )
    `).catch(() => {});
    
    // Seed default Amazon FCs
    await pool.query(`
      INSERT INTO amazon_fc_master (fc_code, city, state) VALUES
        ('DEX3', 'New Delhi', 'DELHI'),
        ('PNQ2', 'New Delhi', 'DELHI'),
        ('DEX8', 'New Delhi', 'DELHI'),
        ('AMD2', 'Ahmedabad', 'GUJARAT'),
        ('SAMB', 'Ahmedabad', 'GUJARAT'),
        ('SDEC', 'Gurugram', 'HARYANA'),
        ('DED5', 'Gurugram', 'HARYANA'),
        ('DED4', 'Gurugram', 'HARYANA'),
        ('DED3', 'Gurugram', 'HARYANA'),
        ('DEL8', 'Gurugram', 'HARYANA'),
        ('DEL5', 'Gurugram', 'HARYANA'),
        ('DEL4', 'Gurugram', 'HARYANA'),
        ('DEL3', 'Gurugram', 'HARYANA'),
        ('DEL2', 'Gurugram', 'HARYANA'),
        ('BLR8', 'Bangalore', 'KARNATAKA'),
        ('BLR7', 'Bangalore', 'KARNATAKA'),
        ('BLR5', 'Bangalore', 'KARNATAKA'),
        ('BLR4', 'Bangalore', 'KARNATAKA'),
        ('BOM7', 'Bhiwandi', 'MAHARASHTRA'),
        ('BOM5', 'Bhiwandi', 'MAHARASHTRA'),
        ('BOM4', 'Mumbai', 'MAHARASHTRA'),
        ('BOM3', 'Mumbai', 'MAHARASHTRA'),
        ('BOM1', 'Mumbai', 'MAHARASHTRA'),
        ('ISK3', 'Mumbai', 'MAHARASHTRA'),
        ('NAG1', 'Nagpur', 'MAHARASHTRA'),
        ('PNQ3', 'Pune', 'MAHARASHTRA'),
        ('HYD3', 'Hyderabad', 'TELANGANA'),
        ('HYD8', 'Hyderabad', 'TELANGANA'),
        ('FHYA', 'Hyderabad', 'TELANGANA'),
        ('SLKA', 'Lucknow', 'UTTAR PRADESH'),
        ('LKO1', 'Lucknow', 'UTTAR PRADESH'),
        ('CCU1', 'Howrah', 'WEST BENGAL'),
        ('SCCA', 'Kolkata', 'WEST BENGAL'),
        ('SCCG', 'Kolkata', 'WEST BENGAL'),
        ('SCCH', 'Kolkata', 'WEST BENGAL'),
        ('SCCC', 'Kolkata', 'WEST BENGAL'),
        ('CCX2', 'Kolkata', 'WEST BENGAL'),
        ('CCX1', 'Kolkata', 'WEST BENGAL'),
        ('QWHF', 'Surat', 'GUJARAT'),
        ('XZUC', 'Surat', 'GUJARAT'),
        ('MAA4', 'Chennai', 'TAMIL NADU'),
        ('CJB1', 'Coimbatore', 'TAMIL NADU'),
        ('LDX1', 'Patiala', 'PUNJAB'),
        ('NAX1', 'Nagpur', 'MAHARASHTRA'),
        ('SBLL', 'Hubballi', 'KARNATAKA'),
        ('ATX1', 'Ludhiana', 'PUNJAB')
      ON CONFLICT (fc_code) DO NOTHING
    `).catch(() => {});

    // ── Amazon Settlement — long format (envelope + line items) ────────────────
    // Replaces the old single-table amazon_settlement_items model. Old table is
    // kept around for back-compat reads but no new writes go to it.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS amazon_settlements (
        settlement_id           TEXT PRIMARY KEY,
        settlement_start_date   DATE,
        settlement_end_date     DATE,
        deposit_date            DATE,
        total_amount            NUMERIC(14,2),
        currency                TEXT DEFAULT 'INR',
        filename                TEXT,
        marketplace             TEXT DEFAULT 'amazon',
        uploaded_at             TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS amazon_settlement_lines (
        id                     SERIAL PRIMARY KEY,
        settlement_id          TEXT,
        posted_date            DATE,
        posted_at              TIMESTAMPTZ,
        transaction_type       TEXT,        -- Order | Refund | Fulfillment Fee Refund | other-transaction
        amount_type            TEXT,        -- ItemPrice | ItemFees | ItemTCS | ItemTDS | Promotion | Item Fee Adjustment | FBA Inventory Reimbursement
        amount_description     TEXT,        -- Principal | Product Tax | FBA Weight Handling Fee | TCS-IGST | TDS (Section 194-O) | …
        amount                 NUMERIC(14,2), -- signed: negative = deduction
        order_id               TEXT,
        merchant_order_id      TEXT,
        shipment_id            TEXT,
        adjustment_id          TEXT,
        order_item_code        TEXT,        -- Amazon's native 14-digit ID, exact match to orders.order_item_id
        merchant_order_item_id TEXT,
        sku                    TEXT,        -- seller SKU (matches orders.sku)
        composite_key          TEXT,        -- legacy only; current imports use natural Amazon keys
        quantity               INT,
        fulfillment_id         TEXT,        -- AFN / MFN
        promotion_id           TEXT,
        marketplace_name       TEXT,        -- Amazon.in
        currency               TEXT DEFAULT 'INR',
        marketplace            TEXT DEFAULT 'amazon',
        brand_name             TEXT,
        uploaded_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await pool.query(`ALTER TABLE amazon_settlement_lines ADD COLUMN IF NOT EXISTS brand_name TEXT`).catch(() => {});
    await pool.query(`UPDATE amazon_settlement_lines SET brand_name = $1 WHERE brand_name IS DISTINCT FROM $1`, [AMAZON_BRAND]).catch(e => console.warn('[db] Amazon settlement brand backfill:', e.message));
    await pool.query(`ALTER TABLE fk_spf_claims ADD COLUMN IF NOT EXISTS order_item_id TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE fk_spf_claims ADD COLUMN IF NOT EXISTS status TEXT`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_amzn_lines_settlement ON amazon_settlement_lines(settlement_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_amzn_lines_order_item ON amazon_settlement_lines(order_item_code)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_amzn_lines_order_id   ON amazon_settlement_lines(order_id)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_amzn_lines_composite  ON amazon_settlement_lines(composite_key)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_amzn_lines_posted     ON amazon_settlement_lines(posted_date)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_amzn_lines_tax_desc   ON amazon_settlement_lines(amount_type, amount_description)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_amzn_lines_order_sku  ON amazon_settlement_lines(order_id, sku)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS IX_amzn_lines_settle_date ON amazon_settlement_lines(settlement_id, posted_date DESC)`).catch(() => {});
    await ensureAmazonSettlementRollups(pool).catch(e => console.warn('[db] Amazon settlement rollups:', e.message));
    await ensureAmazonSettlementReportingRollups(pool).catch(e => console.warn('[db] Amazon reporting rollups:', e.message));

    // ── Amazon: support Order Summary as primary sale source (no real order-item-id) ──
    // The Order Summary file has no order-item-id column. To make it usable as
    // the primary sale source, we (a) drop NOT NULL on orders.order_item_id and
    // (b) add a partial UNIQUE on (order_id, sku) WHERE marketplace='amazon'
    // as the natural key for upserts. Order Reports uploads can later UPDATE
    // the order_item_id column on matching rows.
    await pool.query(`ALTER TABLE orders ALTER COLUMN order_item_id DROP NOT NULL`).catch(e => {
      console.warn('[db] orders.order_item_id DROP NOT NULL:', e.message);
    });
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_amazon_natural
        ON orders (order_id, sku)
        WHERE marketplace = 'amazon'
    `).catch(e => console.warn('[db] uq_orders_amazon_natural:', e.message));

    // Amazon Sale Orders do not include Amazon's native order-item code. A
    // deterministic internal key lets settlement and return reports join on
    // (order_id, sku) without changing either marketplace source value. This
    // only fills missing values; a later Order Report can still replace it.
    await pool.query(`
      UPDATE orders
      SET order_item_id = 'AMZ:' || order_id || ':' || sku
      WHERE marketplace = 'amazon'
        AND order_item_id IS NULL
        AND order_id IS NOT NULL
        AND sku IS NOT NULL
    `).catch(e => console.warn('[db] amazon reporting key backfill:', e.message));

    // ── Seed Admin User (only when ADMIN_SEED_EMAIL + ADMIN_SEED_PASSWORD set) ──
    // Never hardcode production passwords. Existing users are not overwritten.
    const adminEmail = process.env.ADMIN_SEED_EMAIL;
    const adminPass  = process.env.ADMIN_SEED_PASSWORD;
    if (adminEmail && adminPass) {
      const hashedPass = await bcrypt.hash(adminPass, 10);
      const { rowCount } = await pool.query(
        `INSERT INTO users (username, email, password_hash, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING`,
        [process.env.ADMIN_SEED_NAME || 'Administrator', adminEmail, hashedPass, 'admin']
      );
      if (rowCount > 0) {
        console.log(`[db] Seeded Administrator <${adminEmail}>`);
      }
    }

    // Schema version tracking
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id SERIAL PRIMARY KEY,
        version TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // ── order_returns view (deduplicates returns per order item) ─────────────
    await ensureOrderReturnsView(pool);

    // ── unified_settlements view (owned by app boot — not ad-hoc scripts) ─────
    await ensureUnifiedSettlementsView(pool);
    await ensureOrderSettlementTotals(pool);

    await ensureMyntraUploadSchema(pool);
    await ensureMyntraSellerIdSchema(pool);
    await ensureUploadAuditRetentionSchema(pool);
    await ensureNormalizedRateCardSchema(pool);
    await ensureMpInvoiceIdempotencySchema(pool);
    await ensureMpLedgerIdempotencySchema(pool);
    await ensureMyntraPaymentLinkageSchema(pool);
    await ensureMyntraOrderTypeSchema(pool);
    await ensureMyntraItemizedFeesSchema(pool);
    await ensureMyntraRtoReturnDateFix(pool);
    await ensureMyntraPartnerWarehouseSchema(pool);
    await ensureMyntraBlankTrackingRtoFix(pool);
    await ensureMyntraBlankTrackingCancelledFix(pool);
    await ensureMyntraEjRateCardsSeed(pool);
    await ensureDbConnectionOptimization(pool);

    await pool.query(
      `INSERT INTO schema_version (version) VALUES ('2026.07.longterm-1') ON CONFLICT (version) DO NOTHING`
    ).catch(() => {});
    await pool.query(
      `INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
      [CURRENT_SCHEMA_VERSION],
    );

  } catch (e) {
    console.warn('[db] Schema init warning:', e.message);
    // The server must keep its API gated and retry if a required migration
    // fails. Reporting a partially initialized schema as ready caused the
    // browser to appear disconnected even though PostgreSQL was reachable.
    throw e;
  }
}

/**
 * Normalized Multi-Marketplace Rate Card schema (Fee Catalog, Rate Cards, Rules, Imports).
 * Implements the normalized engine while preserving existing rc_* tables.
 */
async function ensureNormalizedRateCardSchema(pool) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM schema_version WHERE version = $1 LIMIT 1`,
    [NORMALIZED_RATE_CARD_SCHEMA_VERSION],
  );
  if (rowCount) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fee_catalog (
      fee_code        TEXT PRIMARY KEY,
      marketplace     TEXT NOT NULL DEFAULT 'all',
      display_name    TEXT NOT NULL,
      fee_group       TEXT NOT NULL, -- revenue, marketplace_fee, logistics, tax, adjustment
      order_level     BOOLEAN NOT NULL DEFAULT true,
      active          BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rate_card_imports (
      id                BIGSERIAL PRIMARY KEY,
      marketplace       TEXT NOT NULL,
      seller_account    TEXT NOT NULL DEFAULT 'default',
      original_filename TEXT NOT NULL,
      file_sha256       TEXT NOT NULL,
      source_type       TEXT NOT NULL, -- xlsx, csv, api, manual
      source_period     TEXT,
      raw_headers       JSONB NOT NULL DEFAULT '[]'::jsonb,
      parse_summary     JSONB NOT NULL DEFAULT '{}'::jsonb,
      status            TEXT NOT NULL DEFAULT 'staged',
      uploaded_by       INTEGER,
      uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (marketplace, seller_account, file_sha256)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketplace_rate_cards (
      id                BIGSERIAL PRIMARY KEY,
      marketplace       TEXT NOT NULL,
      seller_account    TEXT NOT NULL DEFAULT 'default',
      name              TEXT NOT NULL,
      version_name      TEXT NOT NULL,
      effective_from    DATE NOT NULL,
      effective_to      DATE,
      status            TEXT NOT NULL DEFAULT 'draft', -- draft, published, archived
      source_import_id  BIGINT REFERENCES rate_card_imports(id),
      approved_by       INTEGER,
      approved_at       TIMESTAMPTZ,
      created_by        INTEGER,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (effective_to IS NULL OR effective_to >= effective_from),
      UNIQUE (marketplace, seller_account, version_name)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketplace_rate_card_rules (
      id                BIGSERIAL PRIMARY KEY,
      rate_card_id      BIGINT NOT NULL REFERENCES marketplace_rate_cards(id) ON DELETE CASCADE,
      fee_code          TEXT NOT NULL REFERENCES fee_catalog(fee_code),
      category          TEXT,              -- normalized marketplace category; null = all
      brand_name        TEXT,              -- null = all
      fulfilment_type   TEXT,              -- FBA, FLEX, FBF, etc.; null = all
      payment_type      TEXT,              -- prepaid, COD, etc.; null = all
      zone              TEXT,              -- local, zonal, national; null = all
      order_value_min   NUMERIC(14,2) NOT NULL DEFAULT 0,
      order_value_max   NUMERIC(14,2) NOT NULL DEFAULT 999999,
      weight_min_kg     NUMERIC(10,3) NOT NULL DEFAULT 0,
      weight_max_kg     NUMERIC(10,3) NOT NULL DEFAULT 999999,
      quantity_min      NUMERIC(12,3) NOT NULL DEFAULT 0,
      quantity_max      NUMERIC(12,3) NOT NULL DEFAULT 999999,
      calculation_type  TEXT NOT NULL,     -- flat, percentage, per_unit, formula
      rate              NUMERIC(16,6) NOT NULL DEFAULT 0,
      minimum_fee       NUMERIC(14,2),
      maximum_fee       NUMERIC(14,2),
      gst_rate          NUMERIC(8,6),
      tax_inclusive     BOOLEAN NOT NULL DEFAULT false,
      priority          INT NOT NULL DEFAULT 100,
      conditions        JSONB NOT NULL DEFAULT '{}'::jsonb,
      source_reference  JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (order_value_max >= order_value_min),
      CHECK (weight_max_kg >= weight_min_kg),
      CHECK (quantity_max >= quantity_min)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS ix_rate_cards_active_lookup ON marketplace_rate_cards (marketplace, seller_account, status, effective_from DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_rate_rules_lookup ON marketplace_rate_card_rules (rate_card_id, fee_code, category, fulfilment_type, priority)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_fee_catalog_lookup ON fee_catalog (marketplace, fee_group, active)`);

  // Seed fee_catalog with known marketplace fee definitions
  const CATALOG_SEEDS = [
    // Flipkart
    ['commission',              'flipkart', 'Commission',                   'marketplace_fee', true],
    ['fixed_fee',               'flipkart', 'Fixed Closing Fee',            'marketplace_fee', true],
    ['collection_fee',          'flipkart', 'Collection Fee',               'marketplace_fee', true],
    ['pick_pack_fee',           'flipkart', 'Pick & Pack Fee',              'marketplace_fee', true],
    ['reverse_shipping',        'flipkart', 'Reverse Shipping Fee',         'logistics',       true],
    ['franchise_fee',           'flipkart', 'Franchise Fee',                'marketplace_fee', true],
    ['shopsy_marketing_fee',    'flipkart', 'Shopsy Marketing Fee',         'marketplace_fee', true],
    ['cancellation_fee',        'flipkart', 'Cancellation Fee',             'marketplace_fee', true],
    // Amazon
    ['referral_fee',            'amazon',   'Referral / Commission Fee',    'marketplace_fee', true],
    ['closing_fee',             'amazon',   'Fixed Closing Fee',            'marketplace_fee', true],
    ['fba_pick_pack_fee',       'amazon',   'FBA Pick & Pack Fee',          'logistics',       true],
    ['fba_weight_handling_fee', 'amazon',   'FBA Weight Handling Fee',      'logistics',       true],
    ['technology_fee',          'amazon',   'Technology Fee',               'marketplace_fee', true],
    ['refund_commission',       'amazon',   'Refund Commission',            'adjustment',      true],
    // Myntra
    ['myntra_commission',       'myntra',   'Myntra SOR Commission',        'marketplace_fee', true],
    ['myntra_logistics',        'myntra',   'Myntra Logistics Deduction',   'logistics',       true],
    ['myntra_pg_fee',           'myntra',   'Payment Gateway Fee',          'marketplace_fee', true],
    // Meesho
    ['meesho_commission',       'meesho',   'Meesho Marketplace Commission','marketplace_fee', true],
    ['meesho_shipping',         'meesho',   'Meesho Shipping Fee',          'logistics',       true],
  ];

  for (const [code, mp, name, group, orderLvl] of CATALOG_SEEDS) {
    await pool.query(
      `INSERT INTO fee_catalog (fee_code, marketplace, display_name, fee_group, order_level, active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (fee_code) DO UPDATE
       SET display_name = EXCLUDED.display_name, fee_group = EXCLUDED.fee_group, active = true`,
      [code, mp, name, group, orderLvl],
    ).catch(e => console.warn('[db] fee_catalog seed warning:', e.message));
  }

  await pool.query(
    `INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
    [NORMALIZED_RATE_CARD_SCHEMA_VERSION],
  );
  console.log(`[db] Schema ${NORMALIZED_RATE_CARD_SCHEMA_VERSION} applied.`);
}

/**
 * Gives invoice imports a stable natural identity. Legacy duplicate records
 * remain intact for audit, but one canonical legacy row is fingerprinted so a
 * future re-upload updates it instead of appending a second financial line.
 */
async function ensureMpInvoiceIdempotencySchema(pool) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM schema_version WHERE version = $1 LIMIT 1`,
    [MP_INVOICE_IDEMPOTENCY_SCHEMA_VERSION],
  );
  if (rowCount) return;

  await pool.query(`ALTER TABLE mp_invoices ADD COLUMN IF NOT EXISTS source_fingerprint TEXT`);
  // `\x1f` matches the application fingerprint separator. Use the first
  // historical occurrence only: any legacy duplicate stays unchanged and
  // visible, while new uploads become safely idempotent from this point.
  await pool.query(`
    WITH hashed AS (
      SELECT
        id,
        md5(concat_ws(E'\\x1f',
          COALESCE(marketplace, ''),
          COALESCE(seller_account, 'default'),
          COALESCE(invoice_number, ''),
          COALESCE(invoice_date::text, ''),
          COALESCE(sku, ''),
          COALESCE(payment_reference, '')
        )) AS fingerprint
      FROM mp_invoices
      WHERE source_fingerprint IS NULL
    ), ranked AS (
      SELECT id, fingerprint,
             ROW_NUMBER() OVER (PARTITION BY fingerprint ORDER BY id) AS occurrence
      FROM hashed
    )
    UPDATE mp_invoices invoice
    SET source_fingerprint = ranked.fingerprint
    FROM ranked
    WHERE invoice.id = ranked.id
      AND ranked.occurrence = 1
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_mp_invoices_source_fingerprint
    ON mp_invoices (source_fingerprint)
    WHERE source_fingerprint IS NOT NULL
  `);
  await pool.query(
    `INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
    [MP_INVOICE_IDEMPOTENCY_SCHEMA_VERSION],
  );
  console.log(`[db] Schema ${MP_INVOICE_IDEMPOTENCY_SCHEMA_VERSION} applied.`);
}

/**
 * Ledger statements are commonly re-exported and uploaded more than once.
 * Store a stable source identity and retain the original first occurrence so
 * re-importing a statement updates its source values without resetting an
 * operator's reconciliation decision.
 */
/**
 * A Myntra order is settled more than once: a Forward payout, a Reverse
 * refund line for the same order, and sometimes a second payout under a new
 * NEFT reference. Payment rows now keep the Order Release / Order Line /
 * Return identities from the payment export so every settlement of one order
 * stays distinct and can be linked back to the imported Order rows
 * (orders.order_id = Order Release ID, orders.order_item_id = Order Line ID).
 */
async function ensureMyntraPaymentLinkageSchema(pool) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM schema_version WHERE version = $1 LIMIT 1`,
    [MYNTRA_PAYMENT_LINKAGE_SCHEMA_VERSION],
  );
  if (rowCount) return;

  await pool.query(`ALTER TABLE mp_invoices ADD COLUMN IF NOT EXISTS order_release_id TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE mp_invoices ADD COLUMN IF NOT EXISTS order_line_id TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE mp_invoices ADD COLUMN IF NOT EXISTS return_id TEXT`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS IX_mp_inv_release
    ON mp_invoices (marketplace, seller_account, order_release_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS IX_mp_inv_release_line
    ON mp_invoices (order_release_id, order_line_id)`).catch(() => {});

  // Myntra (EJ and VB) return exports carry gatepass columns. Keep them in the
  // account-scoped audit table; they are not part of the normalized model.
  await pool.query(`ALTER TABLE myntra_return_details ADD COLUMN IF NOT EXISTS gatepass_id TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE myntra_return_details ADD COLUMN IF NOT EXISTS gatepass_status TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE myntra_return_details ADD COLUMN IF NOT EXISTS gatepass_type TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE myntra_return_details ADD COLUMN IF NOT EXISTS gatepass_lastmodified DATE`).catch(() => {});

  await pool.query(
    `INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
    [MYNTRA_PAYMENT_LINKAGE_SCHEMA_VERSION],
  );
  console.log(`[db] Schema ${MYNTRA_PAYMENT_LINKAGE_SCHEMA_VERSION} applied.`);
}

/**
 * Myntra payment rows settle as Forward or Reverse (plus NOD non-order
 * deductions). The reporting view splits a row's money between bank
 * settlement and refunded principal using that type, so it must be stored —
 * older imports only carry the sign of the invoice amount as a fallback.
 */
async function ensureMyntraOrderTypeSchema(pool) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM schema_version WHERE version = $1 LIMIT 1`,
    [MYNTRA_ORDER_TYPE_SCHEMA_VERSION],
  );
  if (rowCount) return;

  await pool.query(`ALTER TABLE mp_invoices ADD COLUMN IF NOT EXISTS order_type TEXT`).catch(() => {});
  // Backfill: a Reverse row was stored with a negated invoice amount, and rows
  // that carry a Return ID are Reverse even when amounts were blank.
  await pool.query(`
    UPDATE mp_invoices
    SET order_type = CASE
      WHEN COALESCE(order_release_id, '') = '' THEN 'nod'
      WHEN COALESCE(return_id, '') <> '' OR invoice_amount < 0 THEN 'reverse'
      ELSE 'forward'
    END
    WHERE marketplace = 'myntra' AND order_type IS NULL
  `).catch(() => {});
  await pool.query(
    `INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
    [MYNTRA_ORDER_TYPE_SCHEMA_VERSION],
  );
  console.log(`[db] Schema ${MYNTRA_ORDER_TYPE_SCHEMA_VERSION} applied.`);
}

/**
 * Myntra payment exports itemize each fee, but GST-inclusive. The reporting
 * model needs the GST-free components (commission ex-GST for the rate audit,
 * fixed fee, shipping, pick-pack, gateway, TCS) plus the GST charged on them.
 * Historical rows are backfilled from their bridged other_deductions figure;
 * re-importing a payment file refreshes them with exact components.
 */
async function ensureMyntraItemizedFeesSchema(pool) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM schema_version WHERE version = $1 LIMIT 1`,
    [MYNTRA_ITEMIZED_FEES_SCHEMA_VERSION],
  );
  if (rowCount) return;

  const columns = [
    ['tcs_amount', 'NUMERIC(14,2)'],
    ['fixed_fee_amount', 'NUMERIC(14,2)'],
    ['shipping_fee_amount', 'NUMERIC(14,2)'],
    ['pick_pack_fee_amount', 'NUMERIC(14,2)'],
    ['gateway_fee_amount', 'NUMERIC(14,2)'],
    ['gst_on_mp_fees', 'NUMERIC(14,2)'],
  ];
  for (const [name, type] of columns) {
    await pool.query(`ALTER TABLE mp_invoices ADD COLUMN IF NOT EXISTS ${name} ${type}`).catch(() => {});
  }
  // The view reads these as COALESCE(..., 0) after this migration.
  await pool.query(
    `INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
    [MYNTRA_ITEMIZED_FEES_SCHEMA_VERSION],
  );
  console.log(`[db] Schema ${MYNTRA_ITEMIZED_FEES_SCHEMA_VERSION} applied.`);
}

async function ensureMpLedgerIdempotencySchema(pool) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM schema_version WHERE version = $1 LIMIT 1`,
    [MP_LEDGER_IDEMPOTENCY_SCHEMA_VERSION],
  );
  if (rowCount) return;

  await pool.query(`ALTER TABLE mp_ledger_entries ADD COLUMN IF NOT EXISTS notes TEXT`);
  await pool.query(`ALTER TABLE mp_ledger_entries ADD COLUMN IF NOT EXISTS source_fingerprint TEXT`);
  await pool.query(`ALTER TABLE mp_ledger_entries ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
  // The application canonicalizes debit and credit with exactly two decimals;
  // use the same representation to make legacy rows idempotent on re-upload.
  await pool.query(`
    WITH candidates AS (
      SELECT id,
        md5(concat_ws(E'\\x1f',
          COALESCE(marketplace, ''),
          COALESCE(to_char(entry_date, 'YYYY-MM-DD'), ''),
          COALESCE(reference_number, ''),
          COALESCE(order_id, ''),
          COALESCE(entry_type, 'Other'),
          to_char(COALESCE(debit, 0), 'FM999999999999990.00'),
          to_char(COALESCE(credit, 0), 'FM999999999999990.00'),
          COALESCE(description, '')
        )) AS fingerprint,
        row_number() OVER (
          PARTITION BY md5(concat_ws(E'\\x1f',
            COALESCE(marketplace, ''),
            COALESCE(to_char(entry_date, 'YYYY-MM-DD'), ''),
            COALESCE(reference_number, ''),
            COALESCE(order_id, ''),
            COALESCE(entry_type, 'Other'),
            to_char(COALESCE(debit, 0), 'FM999999999999990.00'),
            to_char(COALESCE(credit, 0), 'FM999999999999990.00'),
            COALESCE(description, '')
          ))
          ORDER BY id
        ) AS occurrence
      FROM mp_ledger_entries
      WHERE source_fingerprint IS NULL
    )
    UPDATE mp_ledger_entries entry
       SET source_fingerprint = candidates.fingerprint
      FROM candidates
     WHERE entry.id = candidates.id
       AND candidates.occurrence = 1
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_mp_ledger_entries_source_fingerprint
    ON mp_ledger_entries (source_fingerprint)
    WHERE source_fingerprint IS NOT NULL
  `);
  await pool.query(
    `INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
    [MP_LEDGER_IDEMPOTENCY_SCHEMA_VERSION],
  );
  console.log(`[db] Schema ${MP_LEDGER_IDEMPOTENCY_SCHEMA_VERSION} applied.`);
}

/**
 * A clear action removes imported business rows, but it must never erase the
 * evidence of which file was used or why an administrator removed it. These
 * fields keep the original upload record immutable while allowing the status
 * board to hide cleared data from its active-dataset view.
 */
async function ensureUploadAuditRetentionSchema(pool) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM schema_version WHERE version = $1 LIMIT 1`,
    [UPLOAD_AUDIT_RETENTION_SCHEMA_VERSION],
  );
  if (rowCount) return;

  await pool.query(`ALTER TABLE upload_log ADD COLUMN IF NOT EXISTS data_cleared_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE upload_log ADD COLUMN IF NOT EXISTS cleared_by TEXT`);
  await pool.query(`ALTER TABLE upload_log ADD COLUMN IF NOT EXISTS cleared_by_email TEXT`);
  await pool.query(`ALTER TABLE upload_log ADD COLUMN IF NOT EXISTS clear_reason TEXT`);
  await pool.query(`ALTER TABLE upload_log ADD COLUMN IF NOT EXISTS cleared_row_counts JSONB`);
  await pool.query(`CREATE INDEX IF NOT EXISTS IX_upload_log_cleared_history ON upload_log(data_cleared_at DESC, uploaded_at DESC)`);
  await pool.query(
    `INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
    [UPLOAD_AUDIT_RETENTION_SCHEMA_VERSION],
  );
  console.log(`[db] Schema ${UPLOAD_AUDIT_RETENTION_SCHEMA_VERSION} applied.`);
}

/**
 * Adds the two-account Myntra import model without making every normal startup
 * repeat broad ALTER/INDEX work. Source rows are retained as JSONB for audit and
 * template changes, while the shared orders/returns tables receive normalized
 * fields for existing reports.
 */
async function ensureMyntraUploadSchema(pool) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM schema_version WHERE version = $1 LIMIT 1`,
    [MYNTRA_UPLOAD_SCHEMA_VERSION],
  );
  if (rowCount) return;

  await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS seller_account TEXT NOT NULL DEFAULT 'default'`);

  // The initial schema used one global order-line key. Seller accounts are
  // independent import boundaries, so the real identity is marketplace +
  // account + line id. Existing data remains valid because it already had a
  // globally unique key.
  await pool.query(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS uq_orders_item`);
  await pool.query(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS "UQ_orders_item"`);
  await pool.query(`ALTER TABLE returns DROP CONSTRAINT IF EXISTS uq_return_order_item`);
  await pool.query(`ALTER TABLE returns DROP CONSTRAINT IF EXISTS "UQ_return_order_item"`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_market_account_item ON orders (marketplace, seller_account, order_item_id)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_returns_market_account_item ON returns (marketplace, seller_account, order_item_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS myntra_order_details (
      id                    BIGSERIAL PRIMARY KEY,
      marketplace           TEXT NOT NULL DEFAULT 'myntra',
      seller_account        TEXT NOT NULL,
      order_line_id         TEXT NOT NULL,
      order_release_id      TEXT,
      store_order_id        TEXT,
      seller_order_id       TEXT,
      order_id_fk           TEXT,
      po_type               TEXT,
      order_created_on      DATE,
      style_id              TEXT,
      seller_sku_code       TEXT,
      myntra_sku_code       TEXT,
      size                  TEXT,
      vendor_article_number TEXT,
      brand                 TEXT,
      style_name            TEXT,
      article_type          TEXT,
      order_status          TEXT,
      packet_id             TEXT,
      seller_packet_id      TEXT,
      courier_code          TEXT,
      tracking_number       TEXT,
      warehouse_id          TEXT,
      packed_on             DATE,
      fmpu_date             DATE,
      inscanned_on          DATE,
      shipped_on            DATE,
      delivered_on          DATE,
      cancelled_on          DATE,
      rto_creation_date     DATE,
      lost_date             DATE,
      return_creation_date  DATE,
      final_amount          NUMERIC(14,2) DEFAULT 0,
      total_mrp             NUMERIC(14,2) DEFAULT 0,
      discount              NUMERIC(14,2) DEFAULT 0,
      coupon_discount       NUMERIC(14,2) DEFAULT 0,
      shipping_charge       NUMERIC(14,2) DEFAULT 0,
      gift_charge           NUMERIC(14,2) DEFAULT 0,
      tax_recovery          NUMERIC(14,2) DEFAULT 0,
      seller_price          NUMERIC(14,2) DEFAULT 0,
      city                  TEXT,
      state                 TEXT,
      zipcode               TEXT,
      source_data           JSONB NOT NULL DEFAULT '{}'::jsonb,
      upload_batch          TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_myntra_order_detail UNIQUE (marketplace, seller_account, order_line_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS myntra_return_details (
      id                      BIGSERIAL PRIMARY KEY,
      marketplace             TEXT NOT NULL DEFAULT 'myntra',
      seller_account          TEXT NOT NULL,
      order_line_id           TEXT NOT NULL,
      order_release_id        TEXT,
      order_group_id          TEXT,
      return_id               TEXT,
      model                   TEXT,
      seller_sku_code         TEXT,
      myntra_sku_code         TEXT,
      style_id                TEXT,
      sku_id                  TEXT,
      brand                   TEXT,
      order_created_date      DATE,
      order_delivered_date    DATE,
      return_created_date     DATE,
      refunded_date           DATE,
      order_rto_date          DATE,
      is_refunded             BOOLEAN,
      exchange_id             TEXT,
      seller_order_id         TEXT,
      return_type             TEXT,
      return_status           TEXT,
      return_state            TEXT,
      store_packet_id         TEXT,
      seller_packet_id        TEXT,
      quantity                INTEGER DEFAULT 1,
      return_mode             TEXT,
      return_reason           TEXT,
      forward_tracking_number TEXT,
      return_tracking_number  TEXT,
      master_bag_id           TEXT,
      lmdo_status             TEXT,
      lmdo_last_modified_on   DATE,
      gatepass_id             TEXT,
      gatepass_status         TEXT,
      gatepass_type           TEXT,
      gatepass_lastmodified   DATE,
      warehouse_id            TEXT,
      partner_warehouse_code  TEXT,
      source_data             JSONB NOT NULL DEFAULT '{}'::jsonb,
      upload_batch            TEXT,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_myntra_return_detail UNIQUE (marketplace, seller_account, order_line_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_orders_myntra_account_date ON orders (seller_account, order_date DESC) WHERE marketplace = 'myntra'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_returns_myntra_account_date ON returns (seller_account, return_requested_date DESC) WHERE marketplace = 'myntra'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_myntra_order_detail_account_date ON myntra_order_details (seller_account, order_created_on DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_myntra_return_detail_account_date ON myntra_return_details (seller_account, return_created_date DESC)`);

  // Rebuild once after the returns account column is available. The view is
  // consumed by the dashboard and must carry the account with each return.
  await ensureOrderReturnsView(pool);
  await pool.query(
    `INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
    [MYNTRA_UPLOAD_SCHEMA_VERSION],
  );
  console.log(`[db] Schema ${MYNTRA_UPLOAD_SCHEMA_VERSION} applied.`);
}

/**
 * Myntra's two files identify the seller in column A. Persist and constrain
 * that identifier so a UI account selection can never silently misclassify
 * VB data as EJ (or the other way around), even if an importer changes later.
 */
async function ensureMyntraSellerIdSchema(pool) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM schema_version WHERE version = $1 LIMIT 1`,
    [MYNTRA_SELLER_ID_SCHEMA_VERSION],
  );
  if (rowCount) return;

  await pool.query(`ALTER TABLE myntra_order_details ADD COLUMN IF NOT EXISTS seller_id TEXT`);
  await pool.query(`ALTER TABLE myntra_return_details ADD COLUMN IF NOT EXISTS seller_id TEXT`);
  await pool.query(`
    UPDATE myntra_order_details
    SET seller_id = NULLIF(TRIM(source_data ->> 'seller id'), '')
    WHERE seller_id IS NULL
  `);
  await pool.query(`
    UPDATE myntra_return_details
    SET seller_id = NULLIF(TRIM(source_data ->> 'seller_id'), '')
    WHERE seller_id IS NULL
  `);

  // Existing legacy rows without a known seller ID are left untouched. The
  // importer itself rejects such a file, while these checks protect every new
  // EJ/VB detail row stored by SQL.
  await pool.query(`
    ALTER TABLE myntra_order_details
    ADD CONSTRAINT ck_myntra_order_account_seller_id
    CHECK (
      seller_account NOT IN ('myntra_ej', 'myntra_vb')
      OR (seller_account = 'myntra_ej' AND seller_id = '45833')
      OR (seller_account = 'myntra_vb' AND seller_id = '10708')
    ) NOT VALID
  `).catch(error => {
    if (error.code !== '42710') throw error;
  });
  await pool.query(`
    ALTER TABLE myntra_return_details
    ADD CONSTRAINT ck_myntra_return_account_seller_id
    CHECK (
      seller_account NOT IN ('myntra_ej', 'myntra_vb')
      OR (seller_account = 'myntra_ej' AND seller_id = '45833')
      OR (seller_account = 'myntra_vb' AND seller_id = '10708')
    ) NOT VALID
  `).catch(error => {
    if (error.code !== '42710') throw error;
  });
  await pool.query(`ALTER TABLE myntra_order_details VALIDATE CONSTRAINT ck_myntra_order_account_seller_id`);
  await pool.query(`ALTER TABLE myntra_return_details VALIDATE CONSTRAINT ck_myntra_return_account_seller_id`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_myntra_order_detail_account_seller ON myntra_order_details (seller_account, seller_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_myntra_return_detail_account_seller ON myntra_return_details (seller_account, seller_id)`);
  await pool.query(
    `INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
    [MYNTRA_SELLER_ID_SCHEMA_VERSION],
  );
  console.log(`[db] Schema ${MYNTRA_SELLER_ID_SCHEMA_VERSION} applied.`);
}

/**
 * Ensures Myntra RTO rows use order_rto_date as the effective return_created_date
 * when return_created_date was recorded as 1970/epoch placeholder in source reports.
 */
async function ensureMyntraRtoReturnDateFix(pool) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM schema_version WHERE version = $1 LIMIT 1`,
    [MYNTRA_RTO_RETURN_DATE_SCHEMA_VERSION],
  );
  if (rowCount) return;

  console.log('[db] Applying Myntra RTO return date fix (order_rto_date -> return_created_date)...');

  // Fix myntra_return_details: update return_created_date to order_rto_date for RTOs where return_created_date was 1970/epoch
  await pool.query(`
    UPDATE myntra_return_details
    SET return_created_date = order_rto_date,
        updated_at = NOW()
    WHERE marketplace = 'myntra'
      AND (return_type = 'RTO' OR return_created_date <= DATE '1970-01-05')
      AND order_rto_date IS NOT NULL
      AND order_rto_date > DATE '1970-01-05'
  `);

  // Fix normalized returns table
  await pool.query(`
    UPDATE returns r
    SET return_requested_date = m.order_rto_date,
        return_date = m.order_rto_date
    FROM myntra_return_details m
    WHERE r.order_item_id = m.order_line_id
      AND r.marketplace = 'myntra'
      AND (r.return_type = 'RTO' OR r.return_requested_date <= DATE '1970-01-05' OR r.return_date <= DATE '1970-01-05')
      AND m.order_rto_date IS NOT NULL
      AND m.order_rto_date > DATE '1970-01-05'
  `);

  // Ensure orders status and return_type are aligned for RTOs
  await pool.query(`
    UPDATE orders o
    SET 
      return_type = 'RTO',
      orders_status = 'RTO'
    FROM returns r
    WHERE o.order_item_id = r.order_item_id
      AND r.marketplace = 'myntra'
      AND r.return_type = 'RTO'
  `);

  await pool.query(
    `INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
    [MYNTRA_RTO_RETURN_DATE_SCHEMA_VERSION],
  );
  console.log(`[db] Schema ${MYNTRA_RTO_RETURN_DATE_SCHEMA_VERSION} applied.`);
}

/**
 * Ensures myntra_return_details has warehouse_id and partner_warehouse_code columns.
 * Backfills warehouse_id and partner_warehouse_code from source_data JSONB if present,
 * maintaining full backwards compatibility for historical and new reports alike.
 */
async function ensureMyntraPartnerWarehouseSchema(pool) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM schema_version WHERE version = $1 LIMIT 1`,
    [MYNTRA_PARTNER_WH_SCHEMA_VERSION],
  );
  if (rowCount) return;

  await pool.query(`ALTER TABLE myntra_return_details ADD COLUMN IF NOT EXISTS warehouse_id TEXT`);
  await pool.query(`ALTER TABLE myntra_return_details ADD COLUMN IF NOT EXISTS partner_warehouse_code TEXT`);
  await pool.query(`
    UPDATE myntra_return_details
    SET warehouse_id = COALESCE(
      NULLIF(TRIM(source_data ->> 'warehouse_id'), ''),
      NULLIF(TRIM(source_data ->> 'seller_warehouse_id'), '')
    )
    WHERE warehouse_id IS NULL AND source_data IS NOT NULL
  `);
  await pool.query(`
    UPDATE myntra_return_details
    SET partner_warehouse_code = NULLIF(TRIM(source_data ->> 'partner_warehouse_code'), '')
    WHERE partner_warehouse_code IS NULL AND source_data ? 'partner_warehouse_code'
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_myntra_return_detail_wh ON myntra_return_details (warehouse_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ix_myntra_return_detail_partner_wh ON myntra_return_details (partner_warehouse_code)`);

  await pool.query(
    `INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
    [MYNTRA_PARTNER_WH_SCHEMA_VERSION],
  );
  console.log(`[db] Schema ${MYNTRA_PARTNER_WH_SCHEMA_VERSION} applied.`);
}

/**
 * Ensures Myntra orders with blank tracking numbers are marked 'Delivered' in orders,
 * with return_type 'RTO', and have a matching RTO entry in returns table with
 * return_reason = 'Cancel before ship'.
 */
async function ensureMyntraBlankTrackingRtoFix(pool) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM schema_version WHERE version = $1 LIMIT 1`,
    [MYNTRA_BLANK_TRACKING_RTO_SCHEMA_VERSION],
  );
  if (rowCount) return;

  console.log('[db] Applying Myntra blank tracking number RTO fix...');

  // 1. Update orders table for all Myntra orders with blank tracking numbers
  await pool.query(`
    UPDATE orders o
    SET 
      orders_status = 'Delivered',
      return_type = 'RTO'
    FROM myntra_order_details m
    WHERE o.marketplace = 'myntra'
      AND o.seller_account = m.seller_account
      AND o.order_item_id = m.order_line_id
      AND (m.tracking_number IS NULL OR TRIM(m.tracking_number) = '')
  `);

  // 2. Synthesize returns records for these blank-tracking orders
  await pool.query(`
    INSERT INTO returns (
      marketplace, seller_account, return_id, order_item_id, order_id,
      fulfilment_type, return_requested_date, return_approval_date, return_date,
      return_status, return_reason, return_sub_reason, return_type, return_result,
      sku, fsn, product_title, quantity
    )
    SELECT 
      'myntra',
      m.seller_account,
      'RTO-' || m.order_line_id,
      m.order_line_id,
      m.order_release_id,
      COALESCE(o.fulfilment_type, 'Non-FBM'),
      COALESCE(m.cancelled_on, m.order_created_on),
      COALESCE(m.cancelled_on, m.order_created_on),
      COALESCE(m.cancelled_on, m.order_created_on),
      'Delivered',
      'Cancel before ship',
      m.source_data ->> 'cancellation reason',
      'RTO',
      'Delivered',
      m.seller_sku_code,
      m.myntra_sku_code,
      m.style_name,
      1
    FROM myntra_order_details m
    LEFT JOIN orders o 
      ON o.marketplace = 'myntra'
     AND o.seller_account = m.seller_account
     AND o.order_item_id = m.order_line_id
    WHERE m.marketplace = 'myntra'
      AND (m.tracking_number IS NULL OR TRIM(m.tracking_number) = '')
    ON CONFLICT (marketplace, seller_account, order_item_id) DO UPDATE
    SET 
      return_reason = 'Cancel before ship',
      return_type = 'RTO',
      return_status = 'Delivered',
      return_requested_date = EXCLUDED.return_requested_date,
      return_date = EXCLUDED.return_date,
      uploaded_at = NOW()
  `);

  await pool.query(
    `INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
    [MYNTRA_BLANK_TRACKING_RTO_SCHEMA_VERSION],
  );
  console.log(`[db] Schema ${MYNTRA_BLANK_TRACKING_RTO_SCHEMA_VERSION} applied.`);
}

/**
 * Ensures Myntra orders with blank tracking numbers are marked 'Cancelled' in orders,
 * with return_type 'Courier Return', and have a matching entry in returns table with
 * return_status = 'Cancelled' and return_reason = 'Cancel Before Dispached'.
 */
async function ensureMyntraBlankTrackingCancelledFix(pool) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM schema_version WHERE version = $1 LIMIT 1`,
    [MYNTRA_BLANK_TRACKING_CANCELLED_SCHEMA_VERSION],
  );
  if (rowCount) return;

  console.log('[db] Applying Myntra blank tracking number Cancelled / Courier Return fix...');

  // 1. Update orders table for all Myntra orders with blank tracking numbers
  await pool.query(`
    UPDATE orders o
    SET 
      orders_status = 'Cancelled',
      return_type = 'Courier Return'
    FROM myntra_order_details m
    WHERE o.marketplace = 'myntra'
      AND o.seller_account = m.seller_account
      AND o.order_item_id = m.order_line_id
      AND (m.tracking_number IS NULL OR TRIM(m.tracking_number) = '')
  `);

  // 2. Synthesize or update returns records for these blank-tracking orders
  await pool.query(`
    INSERT INTO returns (
      marketplace, seller_account, return_id, order_item_id, order_id,
      fulfilment_type, return_requested_date, return_approval_date, return_date,
      return_status, return_reason, return_sub_reason, return_type, return_result,
      sku, fsn, product_title, quantity
    )
    SELECT 
      'myntra',
      m.seller_account,
      'RTO-' || m.order_line_id,
      m.order_line_id,
      m.order_release_id,
      COALESCE(o.fulfilment_type, 'Non-FBM'),
      COALESCE(m.cancelled_on, m.order_created_on),
      COALESCE(m.cancelled_on, m.order_created_on),
      COALESCE(m.cancelled_on, m.order_created_on),
      'Cancelled',
      'Cancel Before Dispached',
      COALESCE(m.source_data ->> 'cancellation reason', 'Cancel Before Dispached'),
      'Courier Return',
      'Cancelled',
      m.seller_sku_code,
      m.myntra_sku_code,
      m.style_name,
      1
    FROM myntra_order_details m
    LEFT JOIN orders o 
      ON o.marketplace = 'myntra'
     AND o.seller_account = m.seller_account
     AND o.order_item_id = m.order_line_id
    WHERE m.marketplace = 'myntra'
      AND (m.tracking_number IS NULL OR TRIM(m.tracking_number) = '')
    ON CONFLICT (marketplace, seller_account, order_item_id) DO UPDATE
    SET 
      return_reason = 'Cancel Before Dispached',
      return_type = 'Courier Return',
      return_status = 'Cancelled',
      return_result = 'Cancelled',
      return_requested_date = EXCLUDED.return_requested_date,
      return_date = EXCLUDED.return_date,
      uploaded_at = NOW()
  `);

  await pool.query(
    `INSERT INTO schema_version (version, applied_at) VALUES ($1, NOW()) ON CONFLICT (version) DO NOTHING`,
    [MYNTRA_BLANK_TRACKING_CANCELLED_SCHEMA_VERSION],
  );
  console.log(`[db] Schema ${MYNTRA_BLANK_TRACKING_CANCELLED_SCHEMA_VERSION} applied.`);
}

async function ensureMyntraEjRateCardsSeed(pool) {
  const { rows } = await pool.query(
    `SELECT 1 FROM schema_version WHERE version = $1`,
    [MYNTRA_EJ_RATE_CARDS_SCHEMA_VERSION],
  );
  if (rows.length > 0) return;

  console.log(`[db] Applying migration ${MYNTRA_EJ_RATE_CARDS_SCHEMA_VERSION}: Seeding Myntra EJ default rate cards...`);

  await pool.query(`
    INSERT INTO rc_pick_pack (category, start_date, end_date, price_min, price_max, rate, marketplace, fulfilment_type, seller_account)
    SELECT category, start_date, end_date, price_min, price_max, rate, marketplace, fulfilment_type, 'myntra_ej'
    FROM rc_pick_pack
    WHERE marketplace = 'myntra' AND seller_account = 'myntra_vb'
      AND NOT EXISTS (
        SELECT 1 FROM rc_pick_pack WHERE marketplace = 'myntra' AND seller_account = 'myntra_ej'
      );

    INSERT INTO rc_reverse_shipping (category, start_date, end_date, price_min, price_max, weight_slab, local_fee, zonal_fee, national_fee, marketplace, seller_account)
    SELECT category, start_date, end_date, price_min, price_max, weight_slab, local_fee, zonal_fee, national_fee, marketplace, 'myntra_ej'
    FROM rc_reverse_shipping
    WHERE marketplace = 'myntra' AND seller_account = 'myntra_vb'
      AND NOT EXISTS (
        SELECT 1 FROM rc_reverse_shipping WHERE marketplace = 'myntra' AND seller_account = 'myntra_ej'
      );
  `);

  await pool.query(
    `INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
    [MYNTRA_EJ_RATE_CARDS_SCHEMA_VERSION],
  );
  console.log(`[db] Schema ${MYNTRA_EJ_RATE_CARDS_SCHEMA_VERSION} applied.`);
}

/**
 * Configures role-level TCP keepalive and idle session timeout on the PostgreSQL server,
 * and clears out any orphaned zombie sessions left behind by terminated backend processes.
 */
async function ensureDbConnectionOptimization(pool) {
  try {
    // 1. Role-level keepalive and idle session policy:
    // Ensures PostgreSQL proactively pings every 30s to prevent NAT firewall drops,
    // explicitly disables idle_session_timeout so pooled connections are NEVER killed by the server,
    // and terminates sessions only if stuck in an uncommitted transaction for > 3 minutes.
    await pool.query('ALTER ROLE CURRENT_USER SET tcp_keepalives_idle = 30;').catch(() => {});
    await pool.query('ALTER ROLE CURRENT_USER SET tcp_keepalives_interval = 5;').catch(() => {});
    await pool.query('ALTER ROLE CURRENT_USER SET tcp_keepalives_count = 5;').catch(() => {});
    await pool.query('ALTER ROLE CURRENT_USER SET idle_session_timeout = 0;').catch(() => {});
    await pool.query("ALTER ROLE CURRENT_USER SET idle_in_transaction_session_timeout = '180s';").catch(() => {});

    // 2. Terminate any preexisting zombie sessions from previous crashed/restarted processes
    const res = await pool.query(`
      SELECT pid, pg_terminate_backend(pid) as terminated
      FROM pg_stat_activity 
      WHERE pid != pg_backend_pid() 
        AND datname = current_database()
        AND usename = current_user
        AND state = 'idle'
        AND (now() - state_change) > interval '5 minutes'
    `).catch(() => ({ rows: [] }));
    if (res.rows?.length > 0) {
      console.log(`[db] Cleaned up ${res.rows.length} orphaned idle database sessions on startup.`);
    }

    await pool.query(
      `INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
      [DB_CONNECTION_OPTIMIZATION_SCHEMA_VERSION],
    ).catch(() => {});
    console.log(`[db] Server-side TCP keepalives and idle session timeout policy confirmed.`);
  } catch (err) {
    console.warn(`[db] Non-critical: Could not apply server connection optimization:`, err.message);
  }
}

/**
 * Bridges physical Amazon return rows to one reporting row per order item.
 * Every LPN/RMA event remains intact in `returns`; this view deliberately
 * selects the newest event only so joins cannot multiply order revenue.
 */
async function ensureOrderReturnsView(pool) {
  const sql = `
DROP VIEW IF EXISTS order_returns;
CREATE OR REPLACE VIEW order_returns AS
      SELECT 
          id, return_id, order_item_id, fulfilment_type, return_requested_date, 
          return_approval_date, return_status, return_reason, return_sub_reason, 
          return_type, return_result, return_expectation, reverse_logistics_tracking_id, 
          sku, fsn, product_title, quantity, return_completion_type, primary_pv_output, 
          detailed_pv_output, final_condition, return_cancellation_reason, marketplace, seller_account,
          uploaded_at, return_date, is_received, received_date, fnsku, order_id, 
          composite_key, shipment_id, carrier, forward_tracking_id, days_in_transit, 
          days_since_return_complete, returned_with_otp, customer_comment, 
          license_plate_number, rma_id, disposition, warehouse_id, return_date_time, 
          units, asin, tech_visit_sla, tech_visit_by_date, tech_visit_completion_datetime, 
          tech_visit_completion_breach, return_completion_sla, return_complete_by_date, 
          return_completion_date, return_completion_breach, return_cancellation_date
      FROM returns
      WHERE marketplace != 'amazon'
      UNION ALL
      SELECT * FROM (
        SELECT DISTINCT ON (o.order_item_id)
            r.id, r.return_id, o.order_item_id as mapped_order_item_id, r.fulfilment_type, r.return_requested_date, 
            r.return_approval_date, r.return_status, r.return_reason, r.return_sub_reason, 
            r.return_type, r.return_result, r.return_expectation, r.reverse_logistics_tracking_id, 
            r.sku, r.fsn, r.product_title, 
            SUM(r.quantity) OVER (PARTITION BY o.order_item_id)::int AS quantity, 
            r.return_completion_type, r.primary_pv_output, 
            r.detailed_pv_output, r.final_condition, r.return_cancellation_reason, r.marketplace, o.seller_account,
            r.uploaded_at, r.return_date, r.is_received, r.received_date, r.fnsku, r.order_id, 
            r.composite_key, r.shipment_id, r.carrier, r.forward_tracking_id, r.days_in_transit, 
            r.days_since_return_complete, r.returned_with_otp, r.customer_comment, 
            r.license_plate_number, r.rma_id, r.disposition, r.warehouse_id, r.return_date_time, 
            r.units, r.asin, r.tech_visit_sla, r.tech_visit_by_date, r.tech_visit_completion_datetime, 
            r.tech_visit_completion_breach, r.return_completion_sla, r.return_complete_by_date, 
            r.return_completion_date, r.return_completion_breach, r.return_cancellation_date
        FROM returns r
        JOIN orders o ON o.order_id = r.order_id AND o.sku = r.sku AND o.marketplace = 'amazon'
        WHERE r.marketplace = 'amazon'
        ORDER BY o.order_item_id, r.return_date_time DESC NULLS LAST, r.uploaded_at DESC
      ) amazon_returns;`;
  try {
    await pool.query(sql);
    console.log('[db] order_returns view ensured');
  } catch (e) {
    console.warn('[db] order_returns view:', e.message);
  }
}

/** Keep unified_settlements in sync on every boot so mp_other_fee etc. cannot drift. */
async function ensureUnifiedSettlementsView(pool) {
  const sql = `
CREATE OR REPLACE VIEW unified_settlements AS
SELECT
    neft_id, neft_type, payment_date,
    COALESCE(bank_settlement, 0) AS bank_settlement,
    input_gst_tcs, income_tax_credits, order_id, order_item_id,
    COALESCE(sale_amount, 0) AS sale_amount,
    COALESCE(total_offer_amount, 0) AS total_offer_amount,
    COALESCE(my_share, 0) AS my_share,
    COALESCE(customer_addons, 0) AS customer_addons,
    COALESCE(marketplace_fee, 0) AS marketplace_fee,
    COALESCE(taxes, 0) AS taxes,
    COALESCE(offer_adjustments, 0) AS offer_adjustments,
    COALESCE(protection_fund, 0) AS protection_fund,
    COALESCE(refund, 0) AS refund,
    tier, commission_rate,
    COALESCE(commission, 0) AS commission,
    COALESCE(fixed_fee, 0) AS fixed_fee,
    COALESCE(collection_fee, 0) AS collection_fee,
    COALESCE(pick_pack_fee, 0) AS pick_pack_fee,
    COALESCE(shipping_fee, 0) AS shipping_fee,
    COALESCE(reverse_shipping, 0) AS reverse_shipping,
    COALESCE(no_cost_emi_fee, 0) AS no_cost_emi_fee,
    installation_fee, tech_visit_fee, uninstallation_fee,
    COALESCE(customer_addon_recovery, 0) AS customer_addon_recovery,
    COALESCE(franchise_fee, 0) AS franchise_fee,
    COALESCE(shopsy_marketing_fee, 0) AS shopsy_marketing_fee,
    COALESCE(cancellation_fee, 0) AS cancellation_fee,
    COALESCE(tcs, 0) AS tcs,
    COALESCE(tds, 0) AS tds,
    COALESCE(gst_on_mp_fees, 0) AS gst_on_mp_fees,
    0::numeric AS mp_other_fee,
    offer_amount_discount_mp, item_gst_rate, discount_mp_fees, gst_on_discount,
    total_discount_mp_fee, offer_adjustment_detail, dead_weight, dimensions,
    volumetric_weight, chargeable_weight_source, chargeable_weight_type,
    chargeable_weight_slab, shipping_zone, order_date, dispatch_date,
    fulfilment_type, seller_sku, quantity, product_sub_category, additional_info,
    return_type, shopsy_order, item_return_status, invoice_id, invoice_date,
    'flipkart'::text AS marketplace, uploaded_at,
    spf_received, spf_received_date, spf_received_amount, spf_received_neft_id
FROM fk_settlement_orders
UNION ALL
${amazonReportingRollupUnifiedSelect()}
UNION ALL
${myntraInvoicesUnifiedSelect()}
UNION ALL
${meeshoSettlementUnifiedSelect()}
`;
  try {
    await pool.query(sql);
    console.log('[db] unified_settlements view ensured (with mp_other_fee)');
  } catch (e) {
    console.warn('[db] unified_settlements view:', e.message);
  }
}
