# Data Optimization Audit — 2026-11-18

Scope: everything that runs when large marketplace files are uploaded and when
the dashboards aggregate them — ingestion (Flipkart, Myntra, Meesho, Amazon,
payments/ledger, SOR), the settlement read model, report queries and caching,
and the database layer. Branch `fix/data-optimization-hardening`.

Every item was confirmed against the code before it was changed. SQL changes
were run against real PostgreSQL 17 (PGlite): totals model vs full rebuild,
returns list and master-category filters, Sale Order shipments, settlement
continuation files, savepoint grouping, month-pl rate cards (new SQL returns
exactly the old results), and the index cleanup migration. The fixes from the
CodeRabbit review (last section) were run the same way.

## Fixed — first pass

| # | Problem you would hit | Fix |
|---|---|---|
| 1 | Dashboards slow whenever a desktop rate-card worker is online (its 2 s heartbeat wiped the report cache) | Worker control-plane writes no longer invalidate; `workers` / `worker_jobs` ignored in the cache version |
| 2 | Catalog / SKU-master upload fails when two listings share a VB EXPORT SKU | One `vb_sku_master` row per master (`mergeVbMasterRows`) |
| 3 | Flipkart return cancelled after approval stays "approved" | The same known `return_id` always takes its new status and date, so a re-upload also corrects a date the old parser stored too late. Between different requests the later date wins; on the same date only a known, non-cancelled status replaces (`RETURN_UPSERT_CONDITION`, in-file twin `returnRowReplaces`) |
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
| 15 | Deploys cut uploads after 5 s | 60 s production drain, `stop_grace_period: 75s`; the drain waits for background imports and is capped 5 s below `STOP_GRACE_PERIOD` |

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
| 10 | SOR uploads / AJIO mirror committed once per invoice (up to 50,000 commits) | Savepoint per invoice, commit per 64, the size of PostgreSQL's per-backend subtransaction cache (`utils/isolatedBatches.js`) |
| 11 | Splitting one Amazon settlement across two files deleted part A | Envelope-less file for a stored settlement appends, removing only as many identical copies as it carries |
| 12 | Amazon Sale Orders: shipments in different monthly files overwrote each other | Per-shipment ledger `amazon_sale_order_shipments`; order qty/amounts = sum of all stored shipments, date = first shipment |
| 13 | `pageSize=100000` list pages; push-report loaded every order into Node | 10,000-row cap (exports still page through all rows); push-report is one `INSERT … SELECT` transaction; `/reconcile/non-order` runs only the requested marketplace |
| 14 | `sku_master` joins doubled orders (unmerged listings, SKU return summary, brand top SKUs) | `NOT EXISTS` / the `sm_mp` + `sm_all` pair |
| 15 | Non-sargable `TO_CHAR(col,'YYYY-MM') = $n` month filters (10 sites) | Half-open date ranges |
| 16 | Redundant indexes slowed inserts; a duplicate index name hid a definition | One migration per table (`2026.11.redundant-indexes-{amazon,returns,sor}-1`) drops 5 covered indexes, each only when its replacement exists and is valid; startup no longer recreates them |
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
| Stored synthesized Myntra returns of lines that later shipped stayed counted | One-time repair `2026.11.myntra-shipped-synthetic-returns-2` removes only those rows, under both the current reason and the legacy `Cancel before ship` (verified: blank-tracking, real and other-account returns kept) |
| month-pl `warnings` "not shown in the UI" | No page calls this endpoint (`fetchMonthPL` is unused in the frontend); the API response carries the warnings for any consumer |

## Deployment notes

- New table `amazon_sale_order_shipments` (`CREATE TABLE IF NOT EXISTS`, both startup paths, also created lazily by the upload).
- `order_settlement_totals` gains two columns (added once, then the model is rebuilt once).
- Migrations `2026.11.redundant-indexes-amazon-1` (`ix_amzn_lines_settlement`, `ix_amzn_lines_order_id`), `-returns-1` (`ix_returns_order_item_id`, `ix_returns_order_id`) and `-sor-1` (`ix_sor_invoice_line_invoice`): one transaction per table with a 5 s lock timeout. A busy table, or a missing / invalid replacement index, leaves only that table's migration pending; it retries on the next start and the old index stays the access path meanwhile.
- `2026.11.search-trgm-1` runs `CREATE EXTENSION IF NOT EXISTS pg_trgm` (a trusted extension; the database owner can create it) and builds two GIN indexes on `orders` concurrently. If the extension cannot be created, search keeps working as a scan and the step is retried on the next start.
- Lookup and trigram index builds (`CREATE INDEX CONCURRENTLY`) run in the background after the required schema, with one owner per database (session advisory lock), so a long upload no longer holds `/api` at 503 while a build waits for it.
- `2026.11.myntra-shipped-synthetic-returns-2` deletes stale synthesized Myntra returns (see above). It was renamed from `-1` when its predicate changed (a version name is never reused for different contents).
- Rate-card worker routes answer 503 until the rate-card worker migration has applied (`services/featureReadiness.js`); every other route is unaffected.
- New optional env vars: `PG_TX_IDLE_TIMEOUT_MS` (default 900000; 0 disables; whole integers only), `SHUTDOWN_TIMEOUT_MS` (whole milliseconds), `STOP_GRACE_PERIOD` (compose; default `75s`, also passed to the app so the drain stays 5 s shorter), `MAINTENANCE_LOCK_TIMEOUT_MS` (`npm run db:analyze`; default 30000, a table whose lock is not granted in time is reported as failed instead of blocking).
- Text uploads (CSV / HTML ".xls") stored before `raw: true` were keyed from SheetJS's guessed values. Re-uploading such a file re-reads it the old way too and adopts the old rows: Myntra payment and ledger fingerprints are re-keyed (`utils/legacyTextParse.js`), and SOR invoice headers are renamed to the exact invoice number when that number is free. A re-upload therefore updates those rows instead of adding a second copy.
- Visible behaviour changes: Insights category breakdowns include an "Uncategorized" bucket and merge marketplace taxonomies; the Returns list shows Amazon and unmatched returns under filters; Sale Statement fees and Myntra VB/EJ cash flows are lower where they were double-counted or mixed; fee-leaks Amazon fees are netted, so refunded orders stop appearing as leaks.

## Data already stored: Data Hub → "Stored data health"

Rows saved by the old parsing are only fully corrected by uploading their file
again, so the Upload page (Data Hub) now has an on-demand **Stored data health**
check (`GET /api/upload/data-health`, `services/dataHealth.js`) that lists what
is affected and what to re-upload:

| Check | What it finds | What to do |
|---|---|---|
| Returns dated before their order | swapped return / order dates | re-upload those months' Orders + Returns |
| Flipkart payments dated before their order | swapped order / payment dates | re-upload Orders + FK Settlement |
| Marketplace payments dated before their invoice | old CSV date guessing (05/04 → 4 May) | re-upload the payment / invoice CSVs |
| Dates in the future | swapped day / month | re-upload the files holding them |
| Uploads that dropped rows for an invalid date or amount | rows lost to the old parsing (`4/25/26`, `-₹1,234`), by file name | re-upload each listed file |
| Myntra orders still carrying removed payments | stale payment or fee columns from deletes made before the fix | **Repair** button (operator / admin) clears them, restores a "Return Initiated" status that only a removed reverse payment set, and rebuilds totals |
| Amazon orders imported before the shipment ledger | orders whose multi-file shipments may have been overwritten | re-upload every Sale Orders file imported before the ledger existed (the ledger only holds shipments from files uploaded after it) |

Every check was run against PostgreSQL 17 with one affected and one clean row
each. A swapped date that still looks plausible (e.g. 4 May vs 5 April with no
contradicting date) cannot be detected from the database alone.

One edge case remains by design: a continuation settlement file repeating a
byte-identical line that is also in part A collapses those two on its first
upload, because the export carries no per-line id that could tell them apart.

## CodeRabbit review (PR #105)

CodeRabbit raised 59 findings: 24 in the review and 35 in two follow-up
comments. Each was checked against the code before anything changed. 55 are
fixed, 1 is partly fixed and 3 are left as they are, with the reasons below.
Tests: `backend/tests/dataOptimizationReviewFixes.test.js` plus updates to the
existing suites. The changed SQL was run on PostgreSQL 17 (PGlite):

- the returns upsert rule, 12 cases, matching its in-file twin;
- the continuation dedupe with the md5 line key, including a fee-refund replay
  after its SKU was resolved;
- per-table index cleanup when a replacement is missing;
- Myntra repair `-2`;
- the Myntra scoped reset, backfill and status restore with payments that carry
  only a line id;
- legacy fingerprint adoption;
- shipment `order_type`;
- the SOR invoice-number rename.

### Fixed

| Area | Finding | Fix |
|---|---|---|
| Startup | Optional index builds on the readiness path | Built in the background after the required schema, one owner per database |
| Startup | Redundant indexes dropped without checking the replacement; one table's lock wait held the others | One migration per table, and each drop first checks that the replacement index is valid |
| Startup | Worker routes usable while the rate-card worker migration is pending | `requireFeatureReady('rate-card-worker')` answers 503 until it applies |
| Startup | SOR view comparison used two pool clients (session-local temp view) | One client |
| Startup | Myntra repair missed the legacy `Cancel before ship` reason | `-2`, matching both reasons (`MYNTRA_SYNTHESIZED_RETURN_REASONS`), also in the Myntra clear and order uploads |
| Shutdown | Docker could kill the app mid-drain; background imports were cut when the pool closed | `STOP_GRACE_PERIOD` drives both compose and the drain cap; shutdown waits for tracked background jobs before `pool.end()` |
| Shutdown / config | Partial values like `60s` or `1e3` accepted for `SHUTDOWN_TIMEOUT_MS` / `PG_TX_IDLE_TIMEOUT_MS` | Whole integers only; otherwise the default |
| DB layer | An idle-timeout termination of a checked-out client could crash the API | Error listener on every client; a client that saw an error is destroyed on release |
| Maintenance | `db:analyze` VACUUM could wait forever for a lock; permission skips counted as success | `lock_timeout` (`MAINTENANCE_LOCK_TIMEOUT_MS`); "skipping" / permission notices count as failed |
| Returns | A return date the old parser stored too late was never corrected; two missing return ids counted as one return; a blank status counted as active | The same known `return_id` always replaces; blank / missing status never replaces on the same date |
| Myntra payments | Reset and backfill used different payment matches; line-only payments were missed | One scope: line ids plus release ids found in orders or payments |
| Myntra payments | A failed refresh after clear was not retryable | The refresh always runs for Myntra; `refreshPending: true` on failure; the backfill endpoint resets before rebuilding |
| Myntra payments | An edit refreshed the new release but not the one it replaced | The row is locked (`FOR UPDATE`) and both the old and new lines are refreshed |
| Myntra payments | Removing the only reverse payment left "Return Initiated" | `restoreMyntraStatusesWithoutReverse` restores the status from the order details unless a return supports it |
| Myntra payments | Re-imports duplicated rows whose IDs the old CSV parsing changed | Legacy fingerprints adopted before the upsert |
| Myntra uploads | Order and return uploads for one account could deadlock | Per-account transaction advisory lock |
| Amazon settlements | Continuation dedupe compared every column of every line with no equality key | md5 line key, hash join |
| Amazon settlements | A fee-refund replay did not match its stored copy after the SKU was resolved | Fee refunds keyed without `sku` / `order_item_code` |
| Amazon settlements | Later sheets of an envelope-free workbook were not safe to replay | Append only when this upload's first write of that settlement replaced it |
| Amazon settlements | Overlapping imports resolving the same orders; charge and refund imported concurrently stayed unresolved | One ingest advisory lock taken before any settlement write, so the second import runs its resolver after the first commits |
| Amazon settlements | Orders whose refund SKU changed were not backfilled | The resolver returns the changed order ids; they are merged into the backfill |
| Amazon settlements | Cross-settlement refund took "the only SKU loaded so far" | That guess is limited to the uploaded settlement; other settlements resolve only by a matching original charge |
| Amazon Sale Orders | A paid order turned `exchange` when a later file held only a zero-price shipment | `order_type` derived from all stored shipments (`BOOL_OR(product_amount > 0)`) |
| Amazon Sale Orders | Same-day shipments at one FC shared a key (date shown without time) | The default short-date format is read as a full ISO date-time |
| Amazon Sale Orders | Batches locked orders in file order | Rows and shipments sorted by order and SKU |
| Flipkart | Concurrent replacements for one NEFT | Transaction advisory lock per table before delete + insert |
| Flipkart | Blank-NEFT SPF claims added on every re-import | Rows without a NEFT id are skipped and counted in `skipped` |
| Dates | ISO read option nulled later text dates in the same column; one sample could set a column's order without parsing | ISO columns fall back to text inference; only a valid decisive parse sets the order |
| SOR | `raw: true` changed zero-padded CSV invoice numbers, so a re-upload duplicated them | The old invoice number is renamed to the exact one when that number is free |
| SOR | Payment ownership check raced the AJIO invoice write; two writers could lock invoices in opposite order | Header locked `FOR UPDATE` and ownership re-checked; every SOR writer sorts by invoice number |
| Reports | `/reconcile/non-order` ignored the Myntra account alias | `marketplaceScope()` |
| Reports | month-pl responses with warnings were cached | Not cached when warnings are present |
| Reports | Search preferred the same-marketplace order with a null-unsafe comparison | `IS NOT DISTINCT FROM` |
| Reports | Stale export page-size comment | Updated to the 10,000-row cap |
| Parsing | Separators removed before validation; `INR ₹1,234.50` rejected | Western / Indian grouping validated; repeated currency markers accepted |
| Parsing | Header layout cache key could collide | `JSON.stringify` of the columns |
| Batching | Failures tracked by value (repeated values); invalid `groupSize` accepted; group of 250 overflowed the subtransaction cache | Tracked by position; `RangeError`; group size 64 |
| Docs | Return date recovery; pre-ledger Sale Orders | This document and the data-health action text |
| Tests | Short-date fixture; per-route read options; exact search call asserted before comparing positions | Added |

### Partly fixed

| Finding | What changed | What is left |
|---|---|---|
| Exports can skip or repeat orders when orders change between page requests (`frontend/src/api/client.js`) | The export stops, creates no partial file and asks for a retry when a page's total differs from the first page's, or a non-final page comes back short | A change that keeps the count the same and reorders rows needs a server-side snapshot or keyset cursor |

### Not changed

| Finding | Reason |
|---|---|
| Refresh SKU mappings when both stored fields are populated (`amazonUpload.js`) | Intentional: the settlement upload only fills missing mappings. A changed mapping comes from the SKU-master upload, whose backfill updates every row that differs (`IS DISTINCT FROM`) |
| Do not delete another part's identical line (`amazonSettlementIngest.js`) | The export has no per-line or per-part id, and the file name is not reliable. Documented above as the one remaining edge case |
| Changed values in an envelope-less re-upload add lines instead of replacing them (`amazonSettlementIngest.js`) | Without its envelope row a file cannot be told apart from a continuation part. A full correction must be uploaded with its envelope row, which replaces the settlement |
