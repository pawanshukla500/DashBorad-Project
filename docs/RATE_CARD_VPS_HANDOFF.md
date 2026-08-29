# Marketplace Rate Card: VPS / Coding-Agent Handoff

> **ARCHITECTURAL UPDATE:** The Rate Card configuration and calculation system described below will **NOT** be built into the existing Node.js/React dashboard app. It will be built as a **separate, standalone Python application** that connects directly to the PostgreSQL database via `DATABASE_URL`. The Python service will handle the rate tables and logic for all marketplaces.

## Copy-paste brief for the coding agent

```text
Build the marketplace rate-card configuration system in the existing Payment
Reconciliation application. Start with Flipkart and Amazon. Do not invent or
seed commercial rates. Myntra Order/Return/Invoice imports are now implemented
for two accounts, so every Myntra rate must be scoped by marketplace + seller
account from the start.

Before making any write:
1. Use the DATABASE_URL supplied by the administrator only on the VPS/server.
   Never print it, commit it, put it in a log, frontend bundle, or email.
2. Inspect the existing schema, rate-card rows, active versions, and marketplace
   accounts. Produce a read-only report and a proposed row diff first.
3. Take/export a database backup or a rate-card snapshot, then use a transaction
   for DML. CockroachDB schema changes run as jobs: wait for SHOW JOBS to succeed
   before using a new column in production queries.
4. Upload/import rate cards into a staging area. Validate and preview the parsed
   rules, dates, overlaps, ranges, coverage, and calculated fee examples.
5. Only an admin may approve/publish a version. Publishing must atomically make
   one version active for a marketplace/account/date and notify
   payments@youthnic.shop through the existing Resend notification service.

Keep the current rc_commission, rc_fixed_fee, rc_collection_fee, rc_pick_pack,
and rc_reverse_shipping tables and their UI working. Implement the richer generic
rate-card tables below as the source of truth for new marketplace/fee types, then
use an adapter or controlled migration rather than running two competing rate
calculators. Do not truncate all rate-card tables. A Flipkart workbook refresh
may only replace flipkart/default rows after preview and approval.
```

## Existing production rules to preserve

- Scope every configuration, upload, version, and calculation by both
  `marketplace` and `seller_account`.
- Current simple rate tables are already scoped this way and support the active
  Flipkart UI. The existing default account IDs are `flipkart/default` and
  `amazon/default`; Myntra is already split into `myntra_ej` and `myntra_vb`.
  Never blend the two accounts.
- Reverse shipping now has three selection dimensions: **order-item value,
  weight, and zone**. Existing rows default to `0` through `999999`, preserving
  their earlier all-price behaviour.
- A rate for a past order is selected by its order date, not today's rate.
- Imports must be idempotent. File checksum + marketplace + seller account +
  source period must prevent duplicate imports.
- Keep raw source files/rows and parser warnings. Parsed data alone is not
  adequate evidence for a marketplace payment dispute.

## Safe VPS discovery commands

Run these as read-only checks after setting `DATABASE_URL` in the server
environment. Do not paste the value into a ticket, terminal screenshot, or chat.

```sql
SELECT current_database(), current_user, now();

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE 'rc_%'
ORDER BY table_name;

SELECT marketplace, seller_account, COUNT(*) AS row_count
FROM rc_reverse_shipping
GROUP BY marketplace, seller_account
ORDER BY marketplace, seller_account;

SELECT marketplace, seller_account, version_name, status,
       effective_from, effective_to, created_at, published_at
FROM rate_card_versions
ORDER BY created_at DESC
LIMIT 50;

SELECT marketplace, account_id, display_name, is_active
FROM marketplace_accounts
ORDER BY marketplace, account_id;
```

For CockroachDB DDL, wait for the schema-change job instead of assuming an
`ALTER TABLE` is usable immediately:

```sql
SELECT job_id, status, running_status, fraction_completed, error
FROM [SHOW JOBS]
ORDER BY created DESC
LIMIT 20;
```

## Current Flipkart table: reverse shipping

This is the immediately usable schema and form model:

```sql
ALTER TABLE rc_reverse_shipping
  ADD COLUMN IF NOT EXISTS price_min NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE rc_reverse_shipping
  ADD COLUMN IF NOT EXISTS price_max NUMERIC(12,2) NOT NULL DEFAULT 999999;
```

The calculation must use the one published row where all conditions match:

```text
marketplace + seller_account
+ category
+ order_date inside start_date/end_date
+ order_value between price_min and price_max
+ order_weight <= matching weight slab ceiling
+ requested zone (local/zonal/national)
= reverse shipping fee
```

UI fields for each Flipkart reverse-shipping rule:

```text
Category | Effective From | Effective To | Order value From | Order value To
| Weight slab | Local fee | Zonal fee | National fee
```

Example CSV (illustrative only; these are not commercial rates):

```csv
marketplace,seller_account,category,effective_from,effective_to,price_min,price_max,weight_slab,local_fee,zonal_fee,national_fee
flipkart,default,kurta,2026-09-01,,0,500,0-0.5 kg,80,100,120
flipkart,default,kurta,2026-09-01,,501,999999,0-0.5 kg,100,120,140
```

Validation required before publish:

- `price_min >= 0`, `price_max >= price_min`.
- A weight slab is mandatory and parsable (store normalized kg values too).
- No overlapping active rules with the same category, fulfilment, price range,
  weight range, and zone selector unless an explicit priority is set.
- No silent gap: show coverage warning when an observed order cannot match a
  rule.

## Generic model for Amazon, Flipkart, and Myntra

The current `rc_*` tables are good adapters for simple screens but are not
enough for Amazon's many fee descriptions or future marketplace-specific rules.
Add this normalized versioned model for new/reworked panels. All money is
`NUMERIC`, never `FLOAT`.

```sql
CREATE TABLE IF NOT EXISTS fee_catalog (
  fee_code        TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  fee_group       TEXT NOT NULL, -- revenue, marketplace_fee, logistics, tax, adjustment
  order_level     BOOLEAN NOT NULL DEFAULT true,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
);

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
);

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
);

CREATE INDEX IF NOT EXISTS ix_rate_cards_active_lookup
  ON marketplace_rate_cards (marketplace, seller_account, status, effective_from DESC);
CREATE INDEX IF NOT EXISTS ix_rate_rules_lookup
  ON marketplace_rate_card_rules (rate_card_id, fee_code, category, fulfilment_type, priority);
```

`conditions` is for marketplace-specific selectors that should not require a
schema rewrite (for example Amazon programme, seller tier, size tier, FC, or a
future Myntra delivery mode). It must be documented/validated per fee code; do
not use it as an unstructured dumping ground for required fields.

## Universal rate-card import format

Use a staging CSV/XLSX sheet with one fee rule per row. Blank selector fields
mean “all”; blank `order_value_max` and `weight_max_kg` are normalized to
`999999`. The parser must retain original sheet row number and raw values.

```csv
marketplace,seller_account,card_name,version_name,effective_from,effective_to,fee_code,category,brand_name,fulfilment_type,payment_type,zone,order_value_min,order_value_max,weight_min_kg,weight_max_kg,quantity_min,quantity_max,calculation_type,rate,minimum_fee,maximum_fee,gst_rate,tax_inclusive,conditions_json,source_sheet,source_row
flipkart,default,Flipkart Standard,FK-2026-09,2026-09-01,,reverse_shipping,kurta,,NON_FBF,,zonal,0,500,0,0.5,0,999999,flat,100,,,0.18,false,"{}",Reverse Shipping,12
amazon,default,Amazon FBA,AMZ-2026-09,2026-09-01,,fba_pick_pack_fee,apparel,,FBA,,,0,999999,0,0.5,0,999999,flat,37,,,0.18,false,"{\"size_tier\":\"standard\"}",FBA Fees,9
```

Import lifecycle:

```text
Upload → store file/checksum/raw headers → parse to staging → validate
→ show new/changed/removed rule diff → sample-order calculation preview
→ admin approval → publish atomically → clear cache → notify team via Resend
```

Do not overwrite an existing published card in place. Create a new version,
auto-close the prior version only after approval, and retain both versions for
historical reconciliation.

## Fee codes to configure first

### Flipkart

```text
commission
fixed_fee
collection_fee
pick_pack_fee
forward_shipping
reverse_shipping
franchise_fee
shopsy_marketing_fee
cancellation_fee
customer_addon_recovery
gst_on_marketplace_fees
tcs
tds
```

`reverse_shipping` must use the order-value + weight + zone selection described
above. Tax fees such as TCS/TDS should only be modeled as rules when the business
intends them to be calculated as expected values; they must not be treated as a
commercial overcharge without the applicable statutory configuration.

### Amazon

Keep payment-line descriptions separate from configured expectations. The
settlement importer already preserves raw Amazon lines; map each raw description
to a canonical fee code, but retain `amount_description` for evidence.

```text
Revenue / promotional lines:
principal
product_tax
shipping
shipping_tax
shipping_discount
shipping_tax_discount

Taxes:
tcs_sgst
tcs_cgst
tds_194_o

FBA fees:
fba_pick_pack_fee
fba_pick_pack_fee_cgst
fba_pick_pack_fee_sgst
fba_weight_handling_fee
fba_weight_handling_fee_cgst
fba_weight_handling_fee_sgst
fixed_closing_fee
fixed_closing_fee_cgst
fixed_closing_fee_sgst

Flex-specific fees:
technology_fee
technology_fee_cgst
technology_fee_sgst
```

Important: FBA and Flex are different fulfilment types. A Flex rule must not
fall back to FBA Pick & Pack; its expected charge is `technology_fee` when that
is the applicable Amazon programme/rate card. Other Amazon fee types can be
added from the raw settlement vocabulary only after the corresponding seller
rate card is supplied and approved.

## Every panel must use the latest valid rate card

Expose one backend service/API, not bespoke calculations in each page:

```text
resolveRateCard({ marketplace, sellerAccount, orderDate })
  → published card whose effective range contains orderDate

calculateExpectedFees({ order, rateCard })
  → fee-code keyed results + matched rule IDs + source references

GET /api/rate-card/effective?marketplace=&seller_account=&on_date=
GET /api/rate-card/coverage?marketplace=&seller_account=&from=&to=
```

Reports, order detail, payment reconciliation, dispute evidence, and dashboard
cards must call this shared service. Return matched rule IDs and source sheet /
row so a team member can explain every expected charge. Cache only published
cards and clear the cache on publication/rollback—never cache an editable draft.

## Notifications and admin confirmation

Use the existing rate-card notification log and Resend service. Recipient:
`payments@youthnic.shop`.

Required server environment variables (never frontend variables):

```env
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=Payments <alerts@verified-domain.example>
RATE_CARD_NOTIFICATION_TO=payments@youthnic.shop
```

Notify on: import staged, validation failed, draft created, rate period saved,
publish, rollback, and deleted rule. Each email must include marketplace,
seller account, version, actor, effective date, and a before/after rule diff.
The admin page must show only configuration readiness and the Resend result
(`accepted`, `failed`, or `skipped`); do not show secrets. `accepted` confirms
Resend accepted the request. Delivery/open confirmation requires a signed Resend
webhook after the VPS has a public HTTPS endpoint.

## Myntra rate-card next phase

1. Preserve the existing `marketplace_accounts` rows: `myntra_ej` (seller ID
   `45833`) and `myntra_vb` (seller ID `10708`).
2. Upload/stage each account’s rate card separately; require its effective date.
3. Map its settlement descriptions to canonical fee codes in a mapping review,
   retaining the raw label.
4. Validate sample orders and only then publish the account-specific version.
5. Never use Flipkart or Amazon defaults as a fallback for Myntra.

## Definition of done

- No raw database connection string, API key, or uploaded rate-card data is
  committed to git or returned by the frontend.
- A dry run presents insert/update/delete counts and validation warnings before
  approval.
- Published history is immutable; rollback restores a previous version rather
  than editing it.
- Existing Flipkart and Amazon uploads/reports continue working.
- Flipkart reverse shipping produces different expected amounts when price bands
  differ but weight/zone are the same.
- Amazon FBA and Flex calculation paths remain distinct.
- Every current rate-card change is logged and can notify the finance team.
