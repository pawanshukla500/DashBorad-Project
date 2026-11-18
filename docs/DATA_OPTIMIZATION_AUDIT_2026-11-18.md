# Data Optimization Audit — 2026-11-18

Scope: everything that runs when large marketplace files are uploaded and when
the dashboards aggregate them — ingestion (Flipkart, Myntra, Meesho, Amazon,
payments/ledger, SOR), the settlement read model, report caching, and the
database layer. Branch `fix/data-optimization-hardening`.

Every fixed item was confirmed against the code first. The SQL changes were
also run against real PostgreSQL 17 (PGlite), and the header-index change was
measured.

## Fixed in this branch

| # | Problem you would hit | Where | Fix |
|---|---|---|---|
| 1 | Dashboards slow (0.5–6 s per tab) whenever a desktop rate-card worker is online: its 2 s heartbeat/claim POSTs wiped the report cache, and its `UPDATE workers` changed the cache's data version | `routes/index.js`, `services/reportCache.js` | Worker control-plane paths no longer invalidate; `workers` / `worker_jobs` ignored in the write-counter version. `/worker-jobs/:id/publish` still invalidates |
| 2 | Catalog / SKU-master upload fails whenever two listings share one VB EXPORT SKU ("ON CONFLICT DO UPDATE command cannot affect row a second time"), after `sku_master` rows were already saved | `routes/upload.js` `upsertSkuMasterRows` | `mergeVbMasterRows` sends one `vb_sku_master` row per master (last non-blank values) |
| 3 | Flipkart return cancelled after approval stays "approved" forever (same return, same request date) — returns overstated in Outstanding/Profit | `routes/upload.js` returns upsert | `RETURN_UPSERT_CONDITION`: same `return_id` always takes its new status; NULL stored date accepts new facts; tie-break between different requests unchanged |
| 4 | Large Myntra files exhaust the 768 MB heap (per-row header index: ~322 MB per 100K rows) | `routes/myntraUpload.js` | Shared index per column layout (`utils/headerIndex.js`): ~4 MB per 100K rows |
| 5 | Myntra payment / ledger uploads freeze the API for minutes (every alias re-scanned and regex-normalised every column of every row) | `routes/mpSettlement.js` | Same shared index: 18.8 s → 0.5 s per 100K rows × 30 aliases (files use ~150) |
| 6 | CSV invoice / ledger / SOR uploads: `05/04/2026` read as 4 May while `13/04/2026` read as 13 April in the same column; 18+ digit order/line IDs lost precision | `routes/mpSettlement.js`, `routes/sorUpload.js` | `raw: true` read option keeps CSV text verbatim (XLSX dates still arrive as Dates) |
| 7 | Flipkart/Meesho XLSX with default-format date cells: dates arrive as US `4/5/26`, stored day-first (5 Apr → 4 May) and `4/25/26` rows skipped as invalid | `routes/upload.js`, `routes/flipkartSettlement.js`, `utils/dateNormalizer.js` | `dateNF: 'yyyy-mm-dd'` renders them as ISO; column format now settled by any decisive value (part > 12), not only the first |
| 8 | Negative currency text `-₹1,234` / `(₹1,234.00)` became NULL — deductions silently dropped | `utils/valueParsers.js` | Sign, parentheses and currency marker accepted in any order; junk still rejected |
| 9 | Editing, deleting or clearing Myntra payments left the dashboards showing the removed money until the next import | `routes/mpSettlement.js` | Backfill affected orders + `refreshOrderSettlementTotals` after each |
| 10 | A retried Meesho upload overlapping the first committed both copies (amounts doubled) | `routes/meeshoUpload.js` | Transaction advisory lock before the DELETE |
| 11 | Every upload re-locked and WAL-stamped all ~330K `order_settlement_totals` rows (`DO UPDATE … WHERE unchanged` still locks) | `services/orderSettlementTotals.js` | Change test moved into the SELECT; only new/changed rows reach the upsert (verified: 0 rows stamped on a no-op refresh vs 2,000 before) |
| 12 | Startup heal sorted the whole Amazon settlement ledger on every boot under the 45 s timeout, uncaught — could keep `/api` at 503 and fail deploys | `services/orderSettlementTotals.js` | Starts from orders missing an id; failures logged, never block readiness |
| 13 | A transaction leaked by an error path held its locks forever (`idle_in_transaction_session_timeout = 0`), blocking later uploads and draining the pool | `db/index.js` | Finite 15 min default (`PG_TX_IDLE_TIMEOUT_MS`, 0 disables); statement timeout still cleared for imports |
| 14 | `npm run db:analyze` cancelled `VACUUM (ANALYZE)` on big tables at 45 s and stopped — later tables (orders, returns, settlements) never maintained | `scripts/analyze-postgres.js` | No statement timeout; per-table failure isolation |
| 15 | Every deploy cut in-flight uploads after 5 s (Docker SIGKILL after 10 s) | `server.js`, `docker-compose.production.yml` | 60 s drain in production, `stop_grace_period: 75s`; dev keeps 5 s |

## Open — not changed here (ranked)

These need a product or schema decision, or a rewrite too large to land
safely without production-sized data. Each was read in the code; amounts
were not checked against production data.

1. **`/returns` drops Amazon and unmatched returns once a filter is set** — `routes/data.js` (`LEFT JOIN orders o` + `buildWhere` on `o.*`). Amazon `returns.order_item_id` holds the LPN/RMA. Needs the join via `order_returns` or `order_id + sku`, with filters on the `ret` side.
2. **Category filter ≠ category breakdown expression** — `buildWhere` default vs `CANONICAL_CATEGORY_SQL`, and `insights.js` groups by raw `o.category` (violates the master-category invariant). Clicking "Uncategorized" filters to 0.
3. **`/settlement/month-pl` uses the slow per-row rate-card subqueries** (11–14 s pattern already replaced elsewhere) and swallows failures as "no RC".
4. **Order search `ILIKE '%q%'`** over orders + the `unified_settlements` view on each keystroke; needs prefix match or `pg_trgm`.
5. **Myntra writes are not atomic** — chunks run on separate pool connections; a mid-file failure skips the backfill and totals refresh.
6. **Synthesised "Cancel Before Dispached" returns are never removed** when a later file shows a tracking number, or when Myntra orders are cleared.
7. **Myntra payment delete/clear leaves `orders.settlement_amount`/fee columns** at their old values (dashboards now use the rebuilt totals; the orders columns need an explicit reset).
8. **Amazon RTO fee-refund SKU resolver is scoped to the uploaded settlement** — uploading settlements out of order leaves refund rows SKU-less (RTO looks like a full FBA loss).
9. **Flipkart SPF / Storage / Ads sheets: delete + insert not transactional**, and the connection-error retry can re-run a committed insert.
10. **SOR uploads / AJIO mirror: one transaction per invoice** (~5 round trips each) inside the request.
11. **Splitting one Amazon settlement across two files deletes the first part.**
12. **Amazon Sale Orders: shipments of one order in different monthly files overwrite each other.**
13. **List endpoints allow `pageSize=100000`** and `/settlement/push-report` loads all orders into Node outside a transaction.
14. **`sku_master` joins can double rows** when a marketplace row and an `'all'` row both exist.
15. **Non-sargable month filters** (`TO_CHAR(col,'YYYY-MM') = $1`) in fee-check / leak endpoints.
16. **Redundant indexes** on `amazon_settlement_lines`, `returns`, `sor_invoice_line`; `IX_orders_vb_export_sku` defined twice (the partial variant is never created). Drop with `DROP INDEX CONCURRENTLY` in a new migration.
17. **Read retries on a saturated pool** can hang a dashboard request ~2 min; consider fail-fast 503 and a small separate upload pool.
18. **Rate-card migration failure blocks all `/api` routes** (throws on lock timeout instead of logging like SOR migrations).
