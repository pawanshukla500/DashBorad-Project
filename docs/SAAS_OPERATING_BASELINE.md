# ReconCentral SaaS operating baseline

This is the minimum operating contract for a trustworthy payment-reconciliation
workspace. It is deliberately focused on source-of-truth data, not only on
dashboard presentation.

## Daily finance workflow

1. Upload each marketplace source only through its dedicated Data Center flow.
   - Flipkart: Sales / Orders → Returns → FK Settlement Report.
   - Amazon: Sale Orders → FBA/Flex Returns → Settlement (Payment).
   - Myntra: select the correct EJ or VB account, then upload Orders → Returns
     → Invoice / Payment.
2. Inspect the import result. Any skipped row has a stored row number, reason,
   and source snapshot in Upload History. Correct the source file and re-upload
   rather than manually changing a financial total.
3. Check Upload Health / Exception Inbox for missing settlements, unlinked
   returns, missing rate cards, and data-date gaps.
4. Review Statements and Payment Check only after their matching settlement
   file has loaded. Reconciliation figures are not a cash-book replacement
   until the bank deposit is independently confirmed.

## Data-integrity rules

- A populated numeric cell must be a real number. Currency/grouping/accounting
  formats such as `₹1,234.50` and `(250.00)` are valid; strings such as
  `12oops` are rejected rather than converted to a misleading value.
- Myntra validates all seller IDs before writing any row. EJ (`45833`) and VB
  (`10708`) are separate account boundaries.
- Myntra rows with malformed dates, malformed money values, invalid quantities,
  or invalid `is_refunded` values are skipped and auditable. A file with no
  valid rows fails without writing business records.
- Myntra invoice/payment rows use an account-scoped source fingerprint. A
  repeated file updates the same invoice line instead of duplicating a payable;
  malformed finance cells are rejected and retained in skipped-row history.
- Manual invoice corrections use that same parser and fingerprint. Invoice
  status must agree with the received amount, except for an explicit dispute.
- Marketplace-ledger imports validate dates, categories, debit/credit rules,
  and running balances. A re-upload updates its matching source entry without
  clearing the operator's reconciliation decision.
- Return-tracking updates accept only defined condition/SPF states and must
  refer to an existing return in the selected marketplace.
- Generic imports are limited to Flipkart. Amazon and Myntra must use their
  dedicated importers so natural keys and marketplace-specific formats remain
  correct.
- Amazon Sale Orders validate required identifiers, dates, quantity, currency,
  and every amount before calculating sales. Settlement transaction lines do
  the same; a scientific-notation item code is left unlinked rather than
  rounded into a wrong order ID.
- Amazon settlement re-upload replaces the matching settlement ID in one
  transaction. It is safe to retry; it does not append a second copy of that
  settlement ledger.
- Amazon FBA/Flex return imports require a stable marketplace identity, a
  positive whole quantity, and valid supplied dates. An incomplete row is
  skipped instead of receiving a row-position-based synthetic key.
- Retained Amazon Order Report and Order Summary APIs apply the same checks to
  populated dates, quantities, money cells, booleans, currency, and natural
  keys. They cannot truncate a fractional quantity or turn a corrupt amount
  into a blank sales record.
- SKU master and catalog COGS imports reject malformed/negative costs, invalid
  weight slabs, bad dates, duplicate keys, and invalid marketplace labels.
  Their writes are batched and report actual insert-versus-update counts.
- The Return Received tracker recognizes the generated template headers
  exactly. A `Yes` requires a valid date and Good/Bad condition; an explicit
  `No` safely removes a prior receipt record and resets the linked return.
- Rate-card rules validate price bands, effective dates, monetary values,
  percentage bounds, fulfillment type, marketplace, and seller account before
  they can affect an overcharge result. Editing a rate period replaces rows in
  one database transaction.
- The legacy Flipkart rate-card workbook is fully parsed before the default
  card is replaced. A missing, unreadable, empty, or malformed workbook leaves
  the active card untouched; the valid replacement itself is transactional.
- Amazon expected-fee rules, marketplace payment configuration, and manual SPF
  receipt marking all validate typed values, identifiers, dates, and boolean
  states before a database write. Explicit zero values remain valid evidence.
- Statement-PDF AI extraction is validated for a coherent period, matching
  month, numeric line values, and credits-minus-debits arithmetic before it
  replaces a saved month.
- Flipkart settlement replacement is atomic at the NEFT level. A malformed
  essential Orders line keeps the existing NEFT batch rather than partially
  replacing it; its per-order settlement read model is refreshed in that same
  transaction.
- Amazon's raw settlement ledger remains the audit source. Its compact
  reporting model retains signed fee components and re-applies the established
  order/day netting before `ABS` is used, so multiple payouts cannot change a
  commission, TCS, GST, or other-fee total.
- Each Amazon settlement replacement refreshes its compact source model inside
  its transaction; after SKU linkage is complete, the per-order totals rebuild
  before the upload returns success. Audited clear actions rebuild both models
  inside their clear transaction. A completed import/clear therefore cannot
  leave an interactive report using a prior settlement ledger snapshot.
- Upload history records insert/update/skip counts. Do not use a successful
  file upload alone as proof that all rows were accepted.
- API mutation audit details redact nested credentials, file/image payloads,
  oversized strings, and circular objects while retaining the action, actor,
  response status, and safe business context.
- Statement, P&L, fee-comparison, and fee-leak report filters accept only a
  canonical marketplace token and valid `YYYY-MM` month where applicable.
  Their SQL bindings are parameterized; a marketplace-scoped statement never
  mixes in Flipkart-only adjustment tables or another marketplace's rate card.

## Fresh, fast reports

- Browser GET responses are de-duplicated and cached in memory for 12 seconds,
  scoped to the Firebase user. Switching tabs can reuse the same report result
  without leaking data across users or persisting it to disk.
- The overview's five aggregate reports have a 45-second server cache. Every
  successful write clears that cache immediately. Identical concurrent report
  requests share one in-flight database query, and an older pre-write response
  cannot repopulate the cache after a mutation.
- The Refresh control sends a cache-bypass token every time, not just on its
  first click. The token is carried through Dashboard, Sales, Returns,
  Profitability, Statements, Rate Audit, Cash Flow, and Insights requests, so
  each of those tabs bypasses the browser cache after an out-of-band change.
- Explicit refresh and return-to-tab revalidation bypass the short browser
  cache. If a transient request fails, the last verified table/chart remains
  visible with an error rather than being replaced by an empty state.
- Statement and Rate Audit sub-reports are requested only when their own tab is
  opened. Payment Check uses the invoice result it already loaded for its fee
  evidence, while the separate rate-card status call remains lightweight.
- Amazon reconciliation retains the previous report during a refresh, clearly
  labels it as stale, and disables export until the requested period arrives.
- Settlement KPIs read a compact, transactionally refreshed per-order model
  instead of rebuilding every fee aggregate from raw Flipkart and Amazon
  ledgers on every tab. The underlying raw ledgers and `unified_settlements`
  view remain available for audit, exports, and read-model rebuilds.
- Refresh rebuilds use transactional `DELETE`/`INSERT` rather than `TRUNCATE`,
  so concurrent dashboard readers continue seeing their prior committed
  snapshot instead of waiting on an exclusive table lock.
- Ordinary report SQL has a 90-second PostgreSQL statement budget by default.
  A slow report returns a clear error instead of consuming a connection
  indefinitely; only the scoped, atomic import/rebuild transaction clears that
  budget while it commits its source replacement.
- Audit History and Return Tracking use the same retryable, user-scoped report
  fetch behavior; pagination or filter changes retain the last verified rows
  until the next response is ready.
- KPI cards animate their numeric portion over a short transition and respect
  the operating system's reduced-motion preference. The final text remains the
  established finance format (₹, %, K/L/Cr, and decimal precision), including
  the profitability workspace's specialised KPI cards.

## Production controls before onboarding users

1. Use PostgreSQL in Docker on the Hostinger VPS with automated backups and a
   tested restore procedure. Keep PostgreSQL on a private Docker/local network;
   do not expose the database port publicly. `PG_SSL=false` is acceptable only
   for that private same-VPS path. A public database host must use TLS.
2. Set `NODE_ENV=production` and `CORS_ORIGINS` to the exact static frontend
   origins. Browser origins outside that allow-list are rejected.
3. Keep Firebase as the only authentication authority. Roles are enforced both
   in navigation and API middleware: viewers read, analysts export, operators
   upload, and admins change users/rates/charges or clear data.
4. Use a low-privilege database user for the API, store database and Firebase
   credentials in the platform secret manager, and rotate any secret ever
   placed in a local file or chat.
5. Monitor `/health`, upload failures, background database recovery, and the
   Audit History. Establish a monthly sample reconciliation from source file →
   database row count → settlement amount → bank credit.
6. Run `npm run db:verify` after a deployment or migration. It confirms the
   active PostgreSQL runtime, TLS state, upload evidence, reconciliation
   fingerprint migrations, and duplicate-fingerprint counts. For Hostinger
   Docker production, `sslEnabled: false` is acceptable only when the API uses
   the private Docker/local database route; otherwise it must report TLS enabled
   with certificate verification.

## Scale checkpoints

- Keep report list endpoints paginated. Do not use the `fetchAll*` helpers for
  a full historical export in normal interactive screens.
- Run `npm run db:analyze` during a scheduled maintenance window after a very
  large import; it performs PostgreSQL maintenance and is not a substitute for
  checking the actual execution plan of a slow query.
- Before a major data-volume increase, capture `EXPLAIN (ANALYZE, BUFFERS)` for
  the Dashboard, Payment Check, Statement, and SKU Profitability queries on a
  safe production-like copy. Add an index only when that evidence shows a
  specific scan or join bottleneck.
