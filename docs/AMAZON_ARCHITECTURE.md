# Amazon data and reporting architecture

This file describes the implementation currently used by the app. It replaces
older notes that described `AMZ-{order_id}-{sku}` as the active linkage key.

## Ownership

- `backend/routes/amazonUpload.js` owns HTTP upload endpoints and Amazon file
  parsing.
- `backend/services/amazonSettlementIngest.js` owns the transactional,
  replacement-safe settlement write.
- `backend/services/amazonSettlementReports.js` is the single source of truth
  for settlement fee classification, summary reporting, non-order reporting,
  pagination, and month filtering.
- `backend/routes/amazonFc.js` owns fulfillment-center CRUD.
- `backend/db/initDb.js` owns tables, indexes, and the
  `unified_settlements` view.

## Active linkage model

New imports use Amazon's natural identifiers:

- Order Reports store the real Amazon `order-item-id` in
  `orders.order_item_id`.
- Order Summary reports use `(order_id, sku)` because they do not contain an
  order item ID.
- FBA returns store the LPN in `returns.order_item_id`; Flex returns store the
  RMA ID there.
- Settlement lines store Amazon's `order-item-code` when it is available.
- Report joins use the item ID for an exact match, then `(order_id, sku)`, or
  `order_id` for lines such as Fulfillment Fee Refunds that omit the SKU.

The `composite_key` columns are retained only for compatibility with historical
data. Current Amazon imports do not populate them.

## Settlement correctness guarantees

An upload may contain one settlement or a combined export containing several.
The importer groups rows by settlement ID and processes each settlement in its
own transaction. When an envelope row is present, its ID and the line IDs must
agree. For each settlement, the importer:

1. upserts the settlement envelope;
2. locks that settlement to serialize concurrent re-uploads;
3. records the previously affected order IDs;
4. deletes the old lines for that settlement;
5. inserts the new lines in batches of 500.

This makes a re-upload idempotent and also allows a corrected source file to
remove an erroneous fee. After commit, SKU resolution and order-column backfill
run only for affected orders while still aggregating those orders across all of
their settlement periods.

## Reporting performance

- The headline summary classifies settlement lines once per aggregate query;
  it no longer uses a chain of scalar subqueries that repeatedly scan the table.
- Non-order details and their total count are returned by one windowed query.
- Pivot pagination reuses the filtered grand-total query's order count, avoiding
  a third scan. Fulfillment/refund/multi-settlement filters apply equally to
  rows, totals, and pagination.
- `YYYY-MM` filters are converted to `[month_start, next_month_start)` date
  ranges, allowing the posted-date index to be used.
- Indexes cover `(order_id, sku)` and `(settlement_id, posted_date)` in addition
  to the basic settlement and posted-date lookups.
- Unknown order-linked charges remain in order P&L categories. They are not
  incorrectly reported as storage/advertising/other non-order costs.
- SKU-master enrichment is reduced to one row per listing SKU, and the unified
  ledger groups by SKU so multi-SKU orders cannot fan out or merge.

## Extending Amazon fees

Add or change broad P&L mapping only in
`backend/services/amazonSettlementReports.js` (`CATEGORY_CASE_SQL`). The pivot,
order backfill, summary, and non-order reports all consume that same mapping.
For a fee that needs rate-card comparison, also add its detailed code and
catalogue entry in `backend/services/amazonReconciliation.js`.
When adding a new output column to `amazon_settlement_lines`, update the table
definition and any corresponding projection in `unified_settlements` together.

## Amazon payment reconciliation parameters

The order-level payment screen is available at **Reconciliation → Amazon
Reconciliation**. It uses the raw settlement ledger as its accounting source;
no Excel row is copied into a new wide settlement table.

`backend/services/amazonReconciliation.js` owns the detailed fee vocabulary:

- Customer value: Principal, Product Tax, Shipping, Shipping Tax, and their
  discount counterparts.
- FBA: Pick & Pack, Weight Handling, Fixed Closing Fee, and each fee's GST.
- Flex: Technology Fee instead of Pick & Pack, plus Weight Handling, Fixed
  Closing Fee, and each fee's GST.
- Statutory deductions: TCS and TDS remain separate from marketplace fees.
- Refunds and Fulfillment Fee Refunds remain credits/review items; they are not
  compared to a full-sale rate rule, which avoids false exceptions on partial
  returns and multi-quantity orders.

Expected amounts are stored in `amazon_rate_card_rules`, not in the raw lines.
An admin can configure a rule by fee, FBA/Flex program, order-value slab,
optional category/brand/weight slab, effective dates, calculation basis
(`per_unit`, `per_order_line`, or `percent_of_sale`), rate, and GST rate.
There are intentionally no seeded Amazon public/default rates. Until a verified
rule exists, the screen reports **Rate needed** instead of a made-up variance.

## Operational checks

- `cd backend && npm test`
- `cd frontend && npm run build`

For production query tuning, use `EXPLAIN (ANALYZE, BUFFERS)` against the real
data volume. Local tests validate query shape and report contracts but cannot
measure the production CockroachDB cluster's network latency or CPU usage.
