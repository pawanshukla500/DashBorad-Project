# Data Optimization Audit — 2026-11-18

Scope: everything that runs when large marketplace files are uploaded and when
the dashboards aggregate them — ingestion (Flipkart, Myntra, Meesho, Amazon,
payments/ledger, SOR), the settlement read model, report queries and caching,
and the database layer. Branch `fix/data-optimization-hardening`.

Every item was confirmed against the code before it was changed. SQL changes
were run against real PostgreSQL 17 (PGlite): totals model vs full rebuild,
returns list and master-category filters, Sale Order shipments, settlement
continuation files, savepoint grouping, month-pl rate cards (new SQL returns
exactly the old results), and the index cleanup migration.

## Fixed — first pass

| # | Problem you would hit | Fix |
|---|---|---|
| 1 | Dashboards slow whenever a desktop rate-card worker is online (its 2 s heartbeat wiped the report cache) | Worker control-plane writes no longer invalidate; `workers` / `worker_jobs` ignored in the cache version |
| 2 | Catalog / SKU-master upload fails when two listings share a VB EXPORT SKU | One `vb_sku_master` row per master (`mergeVbMasterRows`) |
| 3 | Flipkart return cancelled after approval stays "approved" | Same `return_id` always takes its new status (`RETURN_UPSERT_CONDITION`) |
| 4 | Large Myntra files exhaust the 768 MB heap (~322 MB per 100K rows of header maps) | Shared header index (`utils/headerIndex.js`): ~4 MB |
| 5 | Myntra payment / ledger uploads freeze the API for minutes | Same shared index: 18.8 s → 0.5 s per 100K rows × 30 aliases |
| 6 | CSV invoice / ledger / SOR uploads swap day/month and corrupt 18+ digit IDs | `raw: true` keeps CSV text verbatim |
| 7 | Default-format XLSX dates (`4/5/26`) swapped or rows skipped in Flipkart/Meesho uploads | `dateNF: 'yyyy-mm-dd'`; column format settled by any decisive value |
| 8 | `-₹1,234` / `(₹1,234.00)` became NULL | Sign, parentheses and currency accepted in any order |
| 9 | Myntra payment edit/delete/clear left dashboards stale | Backfill + `refreshOrderSettlementTotals` |
| 10 | Overlapping Meesho uploads doubled amounts | Advisory lock before the DELETE |
| 11 | Every upload re-locked all ~330K `order_settlement_totals` rows | Only new/changed rows reach the upsert (0 vs 2,000 rows stamped on a no-op refresh) |
| 12 | Startup heal could keep `/api` at 503 | Scoped to orders missing an id; never blocks readiness |
| 13 | Leaked transactions held locks forever | 15 min idle-in-transaction limit (`PG_TX_IDLE_TIMEOUT_MS`) |
| 14 | `db:analyze` stopped at the first big table | No statement timeout; per-table isolation |
| 15 | Deploys cut uploads after 5 s | 60 s production drain, `stop_grace_period: 75s` |

## Fixed — second pass (previously open)

| # | Problem you would hit | Fix |
|---|---|---|
| 1 | Returns page lost Amazon and unmatched returns once a filter was set | Amazon returns join by `(order_id, sku)` (as `order_returns` does); marketplace/account/date filters fall back to the return's own values (`buildReturnsListQueries`) |
| 2 | Category filter used a different expression than the breakdown; Insights grouped by raw `orders.category` | One master-category definition (`services/categorySql.js`): scalar form for filters, joined form for breakdowns; Insights groups by it and keeps "Uncategorized" |
| 3 | `/settlement/month-pl` ran four correlated rate-card subqueries per settlement row and hid failures as "no RC" | Hash join + `DISTINCT ON` (identical results); failed sections listed in `warnings` |
| 4 | Order search scanned all orders, returns and `unified_settlements` on each keystroke | Exact ids first (indexed); substring fallback only when nothing matches; LIKE wildcards escaped |
| 5 | A Myntra file failing part-way left half its rows saved | One transaction per file; backfill after commit |
| 6 | Synthesized "Cancel Before Dispached" returns never removed | Dropped when the line later has a tracking number, and when Myntra orders are cleared |
| 7 | Payment delete/clear left `orders.settlement_amount` / fee columns set | `resetOrdersWithoutMyntraPayment` before the rebuild |
| 8 | Out-of-order Amazon settlement uploads left RTO refund rows SKU-less (RTO looked like a full FBA loss) | Resolver covers every settlement's orphan refunds for the uploaded orders; touched settlements' rollups rebuilt |
| 9 | Flipkart SPF / Storage / Ads sheets could lose rows; statement retries could double them | Delete + insert per NEFT in one transaction, retried as a whole |
| 10 | SOR uploads / AJIO mirror committed once per invoice (up to 50,000 commits) | Savepoint per invoice, commit per 250 (`utils/isolatedBatches.js`) |
| 11 | Splitting one Amazon settlement across two files deleted part A | Envelope-less file for a stored settlement appends, removing only as many identical copies as it carries |
| 12 | Amazon Sale Orders: shipments in different monthly files overwrote each other | Per-shipment ledger `amazon_sale_order_shipments`; order qty/amounts = sum of all stored shipments, date = first shipment |
| 13 | `pageSize=100000` list pages; push-report loaded every order into Node | 10,000-row cap (exports still page through all rows); push-report is one `INSERT … SELECT` transaction; `/reconcile/non-order` runs only the requested marketplace |
| 14 | `sku_master` joins doubled orders (unmerged listings, SKU return summary, brand top SKUs) | `NOT EXISTS` / the `sm_mp` + `sm_all` pair |
| 15 | Non-sargable `TO_CHAR(col,'YYYY-MM') = $n` month filters (10 sites) | Half-open date ranges |
| 16 | Redundant indexes slowed inserts; a duplicate index name hid a definition | Migration `2026.11.redundant-indexes-1` drops 5 covered indexes; startup no longer recreates them |
| 17 | Saturated pool re-queued reads for ~2 minutes | Fail fast with 503 after one acquire timeout |
| 18 | A pending rate-card migration kept every `/api` route at 503 | Logged and retried on the next start; only rate-card worker features wait |

Also fixed in the second pass:

- Sale Statement and Insights cash flow mixed Myntra VB (10708) and EJ (45833) payments → filtered by `seller_account`; Sale Statement fees follow the dashboard fee rule (fees of paid rows), so a fee and its reversal are no longer counted twice.
- Post-upload `UPDATE orders … FROM sku_master` fills (generic, Myntra, Amazon) rewrote unchanged rows every upload → `IS DISTINCT FROM` guards; the Myntra returns→orders status sync writes only changed rows.
- Lookup index builds ran `CREATE INDEX CONCURRENTLY` under the 45 s read timeout → dedicated client.
- `sor_outstanding` view replaced (ACCESS EXCLUSIVE) on every boot → only when its definition changes.
- Pool clients re-wrapped `query` on every checkout → wrapped once.

## Deployment notes

- New table `amazon_sale_order_shipments` (`CREATE TABLE IF NOT EXISTS`, both startup paths, also created lazily by the upload).
- Migration `2026.11.redundant-indexes-1` drops `ix_amzn_lines_settlement`, `ix_amzn_lines_order_id`, `ix_returns_order_item_id`, `ix_returns_order_id`, `ix_sor_invoice_line_invoice` (5 s lock timeout; retried next start if a table is busy).
- New optional env vars: `PG_TX_IDLE_TIMEOUT_MS` (default 900000; 0 disables), `SHUTDOWN_TIMEOUT_MS`.
- Visible behaviour changes: Insights category breakdowns now include an "Uncategorized" bucket and merge marketplace taxonomies; the Returns list shows Amazon and unmatched returns under filters; Sale Statement fees and Myntra VB/EJ cash flows are lower where they were double-counted or mixed.

## Remaining limitations (by design or needing data)

- Data stored before this branch by the old date/number parsing is not corrected retroactively — re-upload affected CSV/XLSX files.
- Amazon orders imported before the shipment ledger have no shipment rows; re-upload the earlier Sale Orders file once to restore multi-file sums.
- A continuation file that repeats a byte-identical line also present in part A collapses those two on its first upload (no per-line source id exists in the export).
- Order search still falls back to a substring scan when no id matches exactly; a `pg_trgm` index would make that indexed too (needs the extension on the shared server).
- `month-pl`'s per-order fee aggregate still reads `unified_settlements` directly: switching it to `order_settlement_totals` would change its reverse-shipping figure (the two use different rules), so it needs a business decision. The endpoint is report-cached.
- The fee-leaks Amazon branch groups raw settlement lines by amount (identical fee lines merge); left unchanged pending a check against production data.
- The month-pl `warnings` field is returned by the API but not yet shown in the UI.
