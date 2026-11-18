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

## Fixed — third pass (previous limitations)

| Problem | Fix |
|---|---|
| Order search's substring fallback still scanned every order, return and the whole `unified_settlements` view | Substring match runs on `orders` only, backed by GIN trigram indexes (`2026.11.search-trgm-1`, needs `pg_trgm`; plan verified as a bitmap index scan); the matched orders' settlements and returns are fetched by exact id |
| `month-pl` re-aggregated all of `unified_settlements` per request (a switch to the totals table looked like it needed a reverse-shipping decision) | `order_settlement_totals` gains `settled_reverse_shipping` and `settled_protection_fund` with month-pl's own paid-row rules; month-pl reads them. Verified: identical figures for every month × marketplace |
| fee-leaks Amazon branch merged identical fee lines (`GROUP BY … amount`) and summed `ABS()` per line (a charge plus its reversal counted twice) | One row per line; fees netted per order with `ABS(SUM())` like the Amazon rollups. Verified: refunded order ₹20 retained (was ₹220), two identical lines ₹100 (was ₹50) |
| Stored synthesized Myntra returns of lines that later shipped stayed counted | One-time repair `2026.11.myntra-shipped-synthetic-returns-1` removes only those rows (verified: blank-tracking, real and other-account returns kept) |
| month-pl `warnings` "not shown in the UI" | No page calls this endpoint (`fetchMonthPL` is unused in the frontend); the API response carries the warnings for any consumer |

## Deployment notes

- New table `amazon_sale_order_shipments` (`CREATE TABLE IF NOT EXISTS`, both startup paths, also created lazily by the upload).
- `order_settlement_totals` gains two columns (added once, then the model is rebuilt once).
- Migration `2026.11.redundant-indexes-1` drops `ix_amzn_lines_settlement`, `ix_amzn_lines_order_id`, `ix_returns_order_item_id`, `ix_returns_order_id`, `ix_sor_invoice_line_invoice` (5 s lock timeout; retried next start if a table is busy).
- `2026.11.search-trgm-1` runs `CREATE EXTENSION IF NOT EXISTS pg_trgm` (a trusted extension; the database owner can create it) and builds two GIN indexes on `orders` concurrently. If the extension cannot be created, search keeps working as a scan and the step is retried on the next start.
- `2026.11.myntra-shipped-synthetic-returns-1` deletes stale synthesized Myntra returns (see above).
- New optional env vars: `PG_TX_IDLE_TIMEOUT_MS` (default 900000; 0 disables), `SHUTDOWN_TIMEOUT_MS`.
- Visible behaviour changes: Insights category breakdowns include an "Uncategorized" bucket and merge marketplace taxonomies; the Returns list shows Amazon and unmatched returns under filters; Sale Statement fees and Myntra VB/EJ cash flows are lower where they were double-counted or mixed; fee-leaks Amazon fees are netted, so refunded orders stop appearing as leaks.

## Not fixable in code (needs the original files)

- Dates or amounts already stored by the old parsing cannot be told apart from correct ones in the database; re-upload the affected CSV/XLSX files and the new parsing replaces them.
- Amazon orders imported before the shipment ledger have no shipment rows; re-uploading the earlier Sale Orders file once restores multi-file sums.
- A continuation settlement file repeating a byte-identical line that is also in part A collapses those two on its first upload: the export carries no per-line id that could tell them apart.
