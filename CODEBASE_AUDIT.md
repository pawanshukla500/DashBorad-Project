# ReconCentral codebase health audit

**Date:** 2026-09-18  
**Scope:** Architecture, security, settlement/data integrity, reliability, frontend, tests, repo hygiene, ops/deploy.  
**Method:** Read-only review of the current `master` tree. `.env` files were not opened. Secret *values* found in source are referenced by path only and are not repeated here.  
**Deliverable:** This report. No application code was changed.

---

## Executive summary

ReconCentral is a working multi-marketplace finance app with a clearer money pipeline than many dashboards of this age: Firebase auth with role claims, a compact `order_settlement_totals` read model fed from `unified_settlements`, transactional Amazon and Flipkart (Orders sheet) settlement replace, admin clear-data with retained upload history, and a CI job that runs backend Vitest plus a frontend production build before Hostinger Docker deploy.

The highest-risk gaps are not “missing features.” They are **trust gaps on a money system**:

1. A **live TaskFlow personal access token is committed** in docs (rotate immediately).
2. **SQL is string-interpolated** from request query parameters in two report endpoints.
3. **Any authenticated viewer can change outstanding-payment config**, which changes aging and operational totals.
4. **Meesho settlement ingest is append-only** with no unique key, so a re-upload doubles bank/fees in the unified totals.
5. **Amazon still emits synthetic `AMZ:order:sku` keys** in `unified_settlements` when the order join fails, so money can sit under a phantom key while the order remains “unsettled.”

Layered on that: **~1,650 Chrome-profile files are tracked** under `.codex-tmp/` (~31 MB), Flipkart settlement ingest (the original money path) has **no dedicated tests**, “unsettled” means **three different things** on three screens, and several god-files (`data.js` 4.2k lines, `amazonUpload.js` 2.9k, `upload.js` 2.5k) make the next change expensive.

The operating docs (`docs/SAAS_OPERATING_BASELINE.md`, `docs/DATA_CENTER_UPLOADS.md`, `docs/AMAZON_ARCHITECTURE.md`) are unusually good. Treat them as the contract; several of them already describe the desired behavior better than the code.

**Recommended owner sequence:** rotate leaked credentials → close the two authz/SQL holes → stop Meesho double-count and Amazon phantom keys → add Flipkart settlement + outstanding-formula tests → then hygiene (`.codex-tmp`, docs, unused deps). Do not start a rate-card Python rewrite or a `data.js` split until those money-trust items are closed.

---

## What’s already working well

These are real strengths. Keep them; extend them rather than replacing them.

| Area | Evidence |
|------|----------|
| Single API mount + mutation policy | `backend/routes/index.js` applies Firebase `authMiddleware` to `/api` (except health), `mutationAccessGuard` (operator+ writes, admin DELETE) on uploads / statements / disputes / mp-settlement, analyst+ on `/api/export`, admin on charges/audit/rate-card writes. |
| Role model | Firebase claim `recon_role`; `backend/utils/accessRole.js` maps unknown roles to `viewer`; new DB users default to viewer (`backend/services/userSync.js`). Tests: `backend/tests/roles.test.js`, `firebaseIdentity.test.js`, `routeStructure.test.js`. |
| Settlement read model | `unified_settlements` (boot-managed in `backend/db/initDb.js` `ensureUnifiedSettlementsView`) → `ORDER_SETTLEMENT_TOTALS_SELECT` GROUP BY `order_item_id` → `order_settlement_totals`. Dashboard KPIs use `SETT_CTE` (`backend/services/settlementSql.js`). Refresh is `DELETE` then `INSERT` (not `TRUNCATE`) so concurrent readers keep the last committed snapshot (`refreshOrderSettlementTotals` in `backend/services/orderSettlementTotals.js`). |
| Flipkart Orders NEFT replace | Parse first; a bad row poisons its NEFT; `BEGIN` → delete-by-NEFT → insert → `refreshOrderSettlementTotals(client)` → `COMMIT` (`insertOrders` in `backend/routes/flipkartSettlement.js`). Unique `(neft_id, order_item_id)`. |
| Amazon settlement replace | `replaceAmazonSettlement` (`backend/services/amazonSettlementIngest.js`): envelope upsert, `SELECT … FOR UPDATE` on `settlement_id`, delete lines, batched insert via `forEachDbBatch`, rollup refresh in the same transaction. Covered by `backend/tests/amazonSettlementIngest.test.js`. |
| Myntra account boundary | Seller IDs `45833` (EJ) / `10708` (VB) validated before write; DB CHECK constraints; blank tracking → Cancelled + synthesized Courier Return (`backend/routes/myntraUpload.js`). Invoice fingerprint upsert in `backend/routes/mpSettlement.js`. |
| Amazon Flex column swap | File `SKU` = FNSKU, file `mSKU` = merchant SKU — implemented and tested (`amazonUpload.js`, `amazonFlexReturns.test.js`). |
| Clear-data audit | `DELETE /api/upload/clear/:type` requires a reason; business rows deleted; `upload_log` retained with clearer identity (`upload.js`). Tests: `uploadClearAudit.test.js`. |
| Upload security baseline | `backend/utils/uploadSecurity.js` + `spreadsheetFileFilter` on main Data Center paths; tests in `uploadSecurity.test.js`. |
| CORS | Production uses `CORS_ORIGINS`; non-prod allows private LAN HTTP only (`backend/server.js`). |
| DB reliability | Parameterized values almost everywhere; `forEachDbBatch` for PG 65k-param limit; pool statement timeout 45s on reads; `pool.connect()` clears timeout for long imports; read retries vs write fail-fast (`backend/db/index.js`). |
| CI + prod shape | `.github/workflows/deploy-hostinger.yml` runs `npm test --prefix backend` and frontend `vite build`; production is one Node image (`Dockerfile`) on port 3001 behind Traefik (`docker-compose.production.yml`) with `/health`. |
| Frontend cache contract | 12s in-memory GET cache scoped to Firebase UID (`frontend/src/api/client.js`); backend invalidates dashboard cache after successful non-GET (`routes/index.js`). |
| Docs quality | `docs/SAAS_OPERATING_BASELINE.md` and `docs/DATA_CENTER_UPLOADS.md` are operationally specific (remark contract, clear-data evidence, Flipkart NEFT atomicity, Amazon replace). |

---

## Severity-ranked findings

### Critical

#### C1. Live TaskFlow PAT committed in documentation

- **Evidence:** `docs/TASKFLOW_INTEGRATION.md` (MCP `headers.Authorization` example).
- **Impact:** Anyone with repo access (and any public fork/history copy) can call the TaskFlow MCP as the connected user. This is a credential leak, not a documentation typo.
- **Do now:**
  1. Revoke and rotate that PAT in TaskFlow. Treat it as compromised.
  2. Replace the example with a placeholder (`tfp_pat_<from-secret-manager>`).
  3. Search git history / other docs (`GEMINI.md`, agent configs) for the same prefix and scrub.
  4. Add a pre-commit or `gitleaks` rule for `tfp_pat_`.

Secret values are **not** repeated in this report.

#### C2. ~1,650 Chrome profile / Codex temp files are tracked in git

- **Evidence:** `git ls-files .codex-tmp` ≈ **1,652 paths**, ~**31 MB** on disk. `.gitignore` does **not** list `.codex-tmp/` (`.dockerignore` does). Also tracked: `.serena/` (3 files).
- **Impact:** Inflates every clone and CI checkout. Chrome profiles can contain cookies, local storage, and extension state. This is both hygiene and a plausible secret-leak surface.
- **Do now:** Add `.codex-tmp/`, `.serena/`, `*.bak`, and `cookies.json` to `.gitignore`. `git rm -r --cached .codex-tmp .serena backend/routes/rateCard.js.bak`. Consider history purge only if profiles ever held production sessions.

---

### High

#### H1. SQL string interpolation of `seller_account` (authenticated SQL injection)

Two GET report paths build SQL with a quoted query parameter instead of `$n`:

```140:147:backend/routes/reconcile.js
      const myntraAccFilter = (sellerAcc && sellerAcc !== 'all') ? `AND seller_account = '${sellerAcc}'` : '';
      nonOrdQuery = pool.query(`
        SELECT
          ...
          COALESCE((SELECT SUM(amount_received) FROM mp_invoices WHERE marketplace = 'myntra' ${myntraAccFilter} ...
```

```1001:1003:backend/routes/mpSettlement.js
    const sellerAcc = str(req.query.seller_account || req.query.sellerAccount) || 'all';
    const accountWhere = (sellerAcc && sellerAcc !== 'all') ? `AND seller_account = '${sellerAcc}'` : '';
```

The same files already parameterize `seller_account` correctly on other queries (`reconcile.js` ~115, ~302, ~407). This is an oversight, not a pattern.

- **Who can hit it:** Any Firebase-authenticated user (including **viewer**). `/api/reconcile` has no mutation/role guard on GET; `/api/mp-settlement` GET is open to all authenticated roles.
- **Fix:** Bind `$n`. Optionally whitelist `myntra_ej` / `myntra_vb`. Add a regression test that a quote in `seller_account` does not appear raw in SQL.

#### H2. Viewers can change outstanding-payment configuration

- **API:** `PUT /api/reconcile/outstanding/config/:channelKey` in `backend/routes/reconcile.js` (~374–386) has **no** `requireRole` / `mutationAccessGuard`.
- **Mount:** `backend/routes/index.js` mounts `/api/reconcile` **without** `protectMutations`.
- **UI:** `OutstandingPaymentsPage.jsx` `openConfigModal` / `handleUpdateConfig` (~149–176) is not role-gated. The page is reachable by every logged-in user (`App.jsx`).
- **Impact:** Grace days, payment cycle, and `is_active` feed `computeOutstandingMatrix` (`outstandingPaymentsService.js`). A viewer (or a stolen viewer token) can distort aging buckets and “what we are owed.”
- **Tests currently encode the hole:** `backend/tests/outstandingPayments.test.js` issues a live `PUT` with **no auth** against a real DB when configured (~166–191), then writes `grace_period_days` to 16 and back. That is both a missing authz test and a dangerous live mutation.
- **Fix:** `protectMutations(app, '/api/reconcile')` or `requireRole('operator','admin')` on PUT. Hide the config modal unless `hasRole(..., OPS_ROLES)` (or admin-only if that is the product rule). Extend `routeStructure.test.js` / `roles.test.js`. Stop mutating production-like DBs from unit tests.

#### H3. Meesho settlement re-upload duplicates money

- **Ingest:** `backend/routes/meeshoUpload.js` only `INSERT`s. No delete-by-`settlement_id`, no `ON CONFLICT`.
- **Schema:** `meesho_settlement_items` in `backend/db/initDb.js` (~443–461) has **no UNIQUE** on `(settlement_id, order_item_id)` (contrast Flipkart `UQ_fk_sett_neft_item`).
- **Fallback key:** `settlementId = Transaction ID || 'MS-' + (paymentDate || Date.now())` (~74) — many rows without Transaction ID on the same day share one id, or get a unique-per-process timestamp.
- **Downstream:** Rows flow into `unified_settlements` via `meeshoSettlementUnifiedSelect()` and then into `order_settlement_totals`. A second upload **inflates** `net_bank` and fees.
- **Refresh errors swallowed:** `refreshOrderSettlementTotals(pool).catch(e => console.warn(...))` (~118) — totals can stay stale without failing the HTTP 200.
- **UI vs API:** Data Center step-1 buttons are Flipkart / Amazon / Myntra EJ/VB only (`UploadPage.jsx` ~351–355). Meesho exists in `DATA_TYPE_KEYS_BY_MARKETPLACE` and `POST /api/upload/meesho-settlement` (operator+) but is **not** in `docs/DATA_CENTER_UPLOADS.md`. Operators can still hit the API (or a future UI tab) and corrupt totals.
- **Fix before exposing Meesho in the UI:** unique constraint + replace-by-settlement (Flipkart/Amazon pattern); fail the request if totals refresh fails; document the allow-list.

#### H4. Amazon synthetic settlement keys still exist in the unified view

Orders ingest correctly refuses synthetic `AMZ-{order_id}-{sku}` keys (`amazonUpload.js` ~600–606). The Amazon branch of `unified_settlements` still does:

```177:177:backend/services/amazonSettlementReportingRollups.js
    COALESCE(ord.order_item_id, NULLIF(r.order_item_code, ''), 'AMZ:' || r.order_id || ':' || NULLIF(r.sku, '')),
```

(and the same expression in `GROUP BY` ~219).

- **Impact:** `order_settlement_totals` is keyed by `order_item_id`. Phantom `AMZ:…` rows **do not join** `orders.order_item_id`, so the order stays unsettled while bank/fees exist under another key. That is the opposite of the “zero synthetic keys” rule in `AGENTS.md` / `MARKETPLACE_DATA_UPLOAD_SPEC.md`.
- **Partial mitigation:** `ensureOrderSettlementTotals` tries to heal Amazon `orders.order_item_id` from `amazon_settlement_lines.order_item_code` (`orderSettlementTotals.js` ~84–107). Healing does not cover the `AMZ:` fallback when both the order join and `order_item_code` are missing.
- **Fix:** Leave `order_item_id` NULL when the join/code is missing (the totals SELECT already excludes NULL keys). Surface those rows as an exception/unlinked-ledger list, not as a fake order key. Add a SQL assertion test that `amazonReportingRollupUnifiedSelect()` does not contain `'AMZ:'`.

#### H5. Flipkart settlement ingest — core money path — has no dedicated tests

`backend/routes/flipkartSettlement.js` implements NEFT poisoning, atomic Orders replace, and same-transaction totals refresh. **No `backend/tests/*` file references `flipkartSettlement`.** Amazon ingest, by contrast, has `amazonSettlementIngest.test.js`.

If someone breaks the “malformed line keeps the old NEFT” rule, CI will not notice. That is the original marketplace’s settlement path.

#### H6. Large in-memory workbook / JSON limits (availability)

- Multer `memoryStorage()` with **150 MB** caps: `amazonUpload.js`, `meeshoUpload.js`.
- `express.json({ limit: '50mb' })` in `backend/server.js`.
- `xlsx@0.18.5` parses entire buffers in-process; no sheet/row/cell caps on several routes.
- Production compose memory limit is **1G** (`docker-compose.production.yml`).

An authenticated operator (or a stolen operator token) can pin the Node process. SheetJS community 0.18.x is also a known prototype-pollution / unmaintained-lineage risk.

---

### Medium

#### M1. “Unsettled” is not one business definition

Matching **is** join-on `order_item_id` via `unified_settlements` → `order_settlement_totals` for the main KPIs. Filters then diverge:

| Surface | Predicate | Status exclusions |
|---------|-----------|-------------------|
| Dashboard / outstanding matrix | No row in `order_settlement_totals` | Includes **`Courier Return`**; uses `returns` (`data.js` ~316–317, `outstandingPaymentsService.js` ~155+) |
| Reconcile `/summary` and `/unsettled` | `NOT EXISTS` on `order_settlement_totals` | **Omits `Courier Return`**; uses `order_returns` (`reconcile.js` ~207–214) |
| Upload `/unsettled-orders` | Missing totals **or `net_bank <= 0`** | Broader “needs attention” tool, not the same KPI |
| Upload health | `orders - settled` where settled is **only FK + Amazon EXISTS** | Ignores cancellations, Myntra, Meesho (`uploadHealth.js` ~21–27, ~91) |

Myntra blank-tracking orders are labelled `Courier Return`. They drop out of dashboard unsettled but **remain unsettled on Reconcile**. Finance will not trust either number until one function owns the predicate.

#### M2. `SETT_FEE_SQL` duplicated instead of imported

`backend/services/settlementSql.js` exists specifically so “KPI definitions cannot drift.” `backend/routes/data.js` imports `SETT_CTE as SHARED_SETT_CTE` then **redefines** `SETT_FEE_SQL` locally (~232–236) instead of importing it. Reconcile uses a wider `DEDUCTIONS_SQL`. Month P&L still aggregates `unified_settlements` inline in `data.js` rather than only `order_settlement_totals`.

#### M3. God files vs documented architecture

`docs/ARCHITECTURE.md` says routes stay thin and SQL that defines a report lives in a service.

| File | Lines | Reality |
|------|------:|---------|
| `backend/routes/data.js` | 4,211 | Dashboard, settlement, profit, platform summary, push-report |
| `backend/routes/amazonUpload.js` | 2,912 | Ingest + pivot SQL + reconciliation fetch + rate-rule CRUD |
| `backend/routes/upload.js` | 2,512 | Generic upload, SKU/COGS, SPF, clear-data, unsettled report |
| `backend/routes/mpSettlement.js` | 1,486 | Invoices, ledger, Myntra payment |
| `backend/routes/rateCard.js` | 1,204 | Full rate-card HTTP + calculate |
| `frontend/src/pages/RateCardConfigPage.jsx` | 2,718 | |
| `frontend/src/pages/UploadPage.jsx` | 1,955 | |
| `frontend/src/pages/ProfitAnalysisPage.jsx` | 1,858 | |

`docs/AMAZON_ARCHITECTURE.md` assigns pivot/pagination to `amazonSettlementReports.js`; the pivot route still lives in `amazonUpload.js`.

This is maintainability and **review risk**, not an outage. Split along existing service seams after H1–H5, not before.

#### M4. Docs assert a Python rate-card service that does not exist

`docs/ARCHITECTURE.md` and the header of `docs/RATE_CARD_VPS_HANDOFF.md` say rate cards are (or will be) a **separate Python app**. There are **zero `.py` files**. Implementation is Node: `backend/services/rateCard.js` + `backend/routes/rateCard.js`, plus `rateCardScraper.js`. Stub endpoints `POST /refresh` and `GET /intelligence` return empty success (`rateCard.js` ~1119–1120).

Pick one source of truth in the docs. A second Python writer on the same `rc_*` tables would be a split-brain incident.

#### M5. Data Center contract drift (Meesho / Custom / trash UX)

- `docs/DATA_CENTER_UPLOADS.md` and `README.md` list Flipkart / Amazon / Myntra only. Code allow-list also has `meesho` and a `custom` marketplace with no datasets (`UploadPage.jsx` ~46, ~92–102).
- Clear-data **docs** say trash is admin-only. **API** DELETE is admin-only (`mutationAccessGuard`). **UI** shows the trash control to every operator (`UploadPage.jsx` ~1620–1636) and does not import role helpers — operators get a 403 after typing a reason.
- Clearing `myntra_*_invoices` does **not** call `refreshOrderSettlementTotals` (`upload.js` ~1125–1128 vs configs ~1075–1076). Dashboard totals can show invoices that were just deleted until the next import.
- No Meesho type in `CONFIGS` for clear-data.

#### M6. Flipkart non-Orders sheets and Amazon multi-settlement window

- SPF / Storage / Ads / Google Ads in `flipkartSettlement.js` delete+insert **outside** the Orders transaction and **do not** refresh `order_settlement_totals`. A job can commit Orders then fail on Ads.
- Flipkart same-NEFT concurrent re-uploads have **no `FOR UPDATE`** (Amazon does). Last commit wins; unique violations possible.
- Amazon refreshes `order_settlement_totals` **once after the whole workbook** (`amazonUpload.js` ~1811). During a long file, KPIs lag even though each `settlement_id` is already committed.

#### M7. Upload validation gaps and third-party data flows

- Multer **without** `fileFilter`: `mpSettlement.js`, `returnTracking.js`, `statement.js` (PDF).
- Statement PDFs are parsed then sent to **Google Gemini** (`statement.js`). Bank/settlement text leaves the VPS. Document the DPA; keep the “no key → skip AI” path.
- `rateCardScraper.js` uses **puppeteer-extra-plugin-stealth**, writes `cookies.json` at repo root (`COOKIES_PATH` ~13), launches with credentials from env. `cookies.json` is **not** in `.gitignore`. `POST /api/rate-card/sync` is admin-only (good) but ToS / credential / `--no-sandbox` risk remains. Puppeteer is a **production** dependency, so the Hostinger image pays Chromium weight even if sync is unused.

#### M8. No rate limiting; partial security headers

- No `express-rate-limit` (or equivalent). No `trust proxy` for correct client IP behind Traefik.
- Manual headers only: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` (`server.js` ~45–49). No Helmet, CSP, HSTS, Permissions-Policy.
- Acceptable for a small trusted operator set; not acceptable if more viewers/analysts are onboarded (`SAAS_OPERATING_BASELINE.md` “before onboarding users”).

#### M9. Test suite is large but misses the money formula

- **62** Vitest files under `backend/tests/` (~230 `it`/`test` cases). CI runs them.
- **0** frontend tests (no Vitest in `frontend/package.json`).
- Strong: Amazon ingest replace, Flex swap, Myntra seller-ID, upload allow-list *string* tests, roles, `forEachDbBatch`, settlement refresh **SQL shape**.
- Weak / false confidence:
  - `settlementReadModels.test.js` mocks `query` and asserts `DELETE`/`INSERT` strings — not numeric totals.
  - `outstandingPayments.test.js` checks JSON shape and **mutates live config**.
  - `uploadClearAudit.test.js` / `uploadDatasetChoices.test.js` are mostly `fs.readFileSync` source assertions.
  - No tests for Flipkart NEFT replace, `computeOutstandingMatrix` arithmetic (`Total Orders − Returns − Fees − Payment Received`), or Profit Analysis / COGS rollup SQL.

#### M10. Stale `backend/view.sql` and unused split Docker

- Runtime view is `ensureUnifiedSettlementsView()` (Flipkart + Amazon rollups + Myntra + Meesho). `backend/view.sql` is Flipkart + legacy Amazon only. An operator applying `view.sql` by hand would **drop** Myntra/Meesho from KPIs.
- Production uses **root** `Dockerfile` (PORT **3001**, healthcheck). `backend/Dockerfile` (PORT **8080**, no healthcheck) and `frontend/Dockerfile` + `Caddyfile` are leftover split-stack. CI/docs use the unified image.
- `JWT_SECRET` is still written into the VPS `.env` by `.github/workflows/deploy-hostinger.yml` (~64, ~90) but **no backend JS reads it** (Firebase-only auth). Stale secret surface.
- `SAAS_OPERATING_BASELINE.md` says 90s statement timeout; code default is **45s** (`DEFAULT_READ_STATEMENT_TIMEOUT_MS`), which matches compose/`HOSTINGER_DEPLOY.md`. Fix the SaaS doc.

#### M11. Frontend role UX vs API

- Upload + Return Tracking gated to `OPS_ROLES`; admin pages gated (`App.jsx`). Exports use `canExport` (analyst+). Aligns with API for those routes.
- Non-admins hitting `/rate-card-config` redirect to **`/upload`** (an ops page) instead of `/` (`App.jsx` ~186–188).
- Backend `normalizedRole` rejects unknown claims to `viewer`; frontend `normalizeRole` only maps legacy `user` → `operator` (`frontend/src/utils/roles.js` vs `backend/utils/accessRole.js`).
- `MARKETPLACES` constant includes Meesho/Custom but step-1 buttons do not use it — dead UI data.

---

### Low

#### L1. Example env files contain a real DB username and START.bat hardcodes a VPS IP

- `backend/.env.example` and `docs/HOSTINGER_DEPLOY.md` use a real role name in `DATABASE_URL` examples (password placeholder only). Prefer `USER:PASSWORD@postgres:5432`.
- `START.bat` probes `200.141.1.119:5433` then falls back to SSH tunnel. Docs say Postgres is loopback-bound. The IP is inventory disclosure; if that probe ever succeeds from a laptop, the DB is more exposed than the docs claim — verify with `ss`/`docker ps` on the VPS, do not open 5433 on WAN.

#### L2. Firebase web config hardcoded as fallback

`frontend/src/api/firebase.js` prefers `VITE_FIREBASE_*` then falls back to a committed web config. Firebase web API keys are expected-public, but the file comments “never commit production secrets” while doing so. Prefer env-only in production builds; restrict Auth authorized domains.

`createUserWithEmailAndPassword` is exported and unused in UI. Confirm Firebase Console has **self-signup disabled**; `userSync` would otherwise create **viewer** rows for anyone who can hit the Auth API.

#### L3. Unused / heavy dependencies

| Package | Issue |
|---------|--------|
| `cheerio` | Declared in `backend/package.json`; **no source import**. |
| `bcryptjs` | Only `ADMIN_SEED_*` password hash in `initDb.js`; Firebase is the auth authority. |
| `puppeteer` + stealth | Production deps for an admin scrape path. Move to optional/dev or a separate worker image. |
| `xlsx` 0.18.5 | Backend + frontend. Plan `exceljs` or SheetJS professionally-supported build for ingest. |

#### L4. Scratch scripts are mixed with real ops scripts

Tracked `backend/scripts/` (24 files) mixes production tools (`backup-db.js`, `verify-postgres-runtime.js`, `analyze-postgres.js`) with probes (`test_health_query.js`, `test_reco_perf.js`, `test_simple.js`, `check_*.js`). Root one-off `fix_*.js` / `*.cjs` patterns are already gitignored (good). Also tracked: `backend/test-visual.js`, `backend/routes/rateCard.js.bak`.

Keep backup/verify/analyze. Move probes to an ignored `scratch/` or delete.

#### L5. Shared formatter drift

`OutstandingPaymentsPage.jsx` defines a local integer `formatCurrency` instead of `frontend/src/utils/format.js`. Sidebar does not filter tabs with `canAccessTab` the way `WorkspaceNav` does.

#### L6. `.env` is not tracked (good)

`.gitignore` covers `.env`, `backend/.env`, `frontend/.env*`, `serviceAccount*.json`. Only `.env.example` files are tracked. No live `.env` was found in `git ls-files`.

---

## Prioritized action list

Use **Now / Next / Later** rather than calendar weeks. Each item is sized for a small PR.

### Now (trust and leak stop)

1. **Rotate** the TaskFlow PAT. Redact `docs/TASKFLOW_INTEGRATION.md`. Scan history for `tfp_pat_`.
2. **Stop tracking** `.codex-tmp/`, `.serena/`, `rateCard.js.bak`. Gitignore those plus `cookies.json` and `**/cookies.json`.
3. **Parameterize** `seller_account` in `reconcile.js` and `mpSettlement.js`. Add a test that interpolation cannot recur (`routeStructure` or a small SQL-builder unit test).
4. **Guard** `PUT /api/reconcile/outstanding/config/:channelKey` with operator/admin (or admin-only). Gate the Outstanding config modal. Fix `outstandingPayments.test.js` so it never PUTs a live database without an explicit test DB + rollback.
5. **Confirm** Firebase self-registration is off and Postgres `5433` is not published on `0.0.0.0`.

### Next (money correctness)

6. **Meesho:** unique `(settlement_id, order_item_id)` + replace-on-reupload + fail if `refreshOrderSettlementTotals` fails. Then either document+show the Data Center tab or remove the dead allow-list entry.
7. **Amazon:** remove `'AMZ:' || …` from `amazonReportingRollupUnifiedSelect`; treat unlinkable lines as exceptions. Test the SQL string.
8. **One `unsettledPredicate()`** used by dashboard, outstanding, reconcile, and upload-health (include `Courier Return`; pick `returns` vs `order_returns` once). Update `uploadHealth.js` comment and Myntra/Meesho linkage.
9. **Flipkart settlement tests:** fixture workbook (or row arrays) covering (a) valid NEFT replace, (b) one bad Orders row leaves that NEFT untouched, (c) totals refresh in the same transaction. Mock `pg` like Amazon ingest tests.
10. **Unit-test `computeOutstandingMatrix`** with fixed in-memory rows: `Total Orders − Returns − Marketplace Fees − Payment Received`.
11. **Clear-data:** hide trash unless `user.role === 'admin'`; call `refreshOrderSettlementTotals` when `mp_invoices` is cleared; add a Meesho clear type if Meesho stays.
12. **Upload hardening:** `spreadsheetFileFilter` / PDF filter on `mpSettlement`, `returnTracking`, `statement`; row/sheet caps; lower 150 MB where business-realistic; `express-rate-limit` on `/api/upload/*` and `/api/statement` keyed by Firebase UID; `app.set('trust proxy', 1)`.

### Later (maintainability and product)

13. Import `SETT_FEE_SQL` in `data.js`; move Amazon pivot SQL into `amazonSettlementReports.js` to match `docs/AMAZON_ARCHITECTURE.md`.
14. Peel report SQL out of `data.js` / `amazonUpload.js` **one endpoint family at a time** (settlement KPIs, then profit, then Amazon pivot). Do not rewrite all 4k lines in one PR.
15. Rewrite `docs/ARCHITECTURE.md` / `RATE_CARD_VPS_HANDOFF.md` so Node is the rate-card system of record, or isolate Python as a future *reader* only.
16. Frontend Vitest: allow-list in `UploadPage.jsx`, role redirects in `App.jsx`, Outstanding config hidden for viewers.
17. Drop unused `cheerio`; demote Puppeteer from the production image; replace `xlsx` on a planned ingest branch; delete `JWT_SECRET` from deploy env; mark `backend/Dockerfile` + `frontend/Caddyfile` deprecated.
18. Incremental `order_settlement_totals` refresh (by marketplace / settlement id) if full-table rebuild becomes the bottleneck — not before the unique-key and predicate bugs are gone.
19. Optional: Helmet/CSP; object storage for original upload bytes (docs already say binaries are not stored).

---

## Quick wins (≤ 1 day each)

| Win | Why it pays |
|-----|-------------|
| Gitignore + untrack `.codex-tmp` | Instant clone/CI shrink; removes profile leak risk |
| Redact TaskFlow example + rotate PAT | Stops an active credential |
| `$n` bind for the two `seller_account` interpolations | Closes SQLi on finance reports |
| `protectMutations` on `/api/reconcile` | Closes viewer writes to outstanding config |
| Hide Upload trash unless admin | Matches docs and API |
| Import `SETT_FEE_SQL` from `settlementSql.js` | Prevents silent KPI drift |
| Add `'Courier Return'` to reconcile unsettled exclusions | Aligns Reconcile with Dashboard/Myntra |
| `.gitignore` `cookies.json` | Prevents Flipkart session commit |
| Delete `backend/routes/rateCard.js.bak` | Dead file |
| Remove `cheerio` from `backend/package.json` | Unused prod dep |
| Stop writing `JWT_SECRET` in deploy workflow | Unused secret |
| Fix SaaS doc 90s → 45s timeout | Docs match `db/index.js` and compose |
| Redirect unauthorized `/rate-card-config` to `/` not `/upload` | Stops viewers landing on an ops page |

---

## Settlement matching — verified model (not a rubber stamp)

```text
fk_settlement_orders  ─┐
amazon reporting rollups ─┼─► unified_settlements (VIEW, boot in initDb.js)
mp_invoices (Myntra)  ─┤         │
meesho_settlement_items ─┘         ▼
                          GROUP BY order_item_id
                                   ▼
                          order_settlement_totals (TABLE)
                                   ▼
                          SETT_CTE → dashboard / outstanding / most KPIs
```

- **Join key:** `orders.order_item_id` = `unified_settlements.order_item_id` = `order_settlement_totals.order_item_id`.
- **Unsettled (intended):** no totals row, excluding cancelled/return-like orders. **Implemented inconsistently** (see M1).
- **Flipkart NEFT atomicity:** confirmed for the **Orders sheet + totals** in one transaction. Not confirmed for the full multi-sheet workbook.
- **Amazon `settlement_id` replace:** confirmed, including `FOR UPDATE`.
- **`refreshOrderSettlementTotals`:** full-table rebuild; transactional when passed a pool; joins the caller’s transaction when passed a client. Called from Flipkart Orders ingest, Amazon settlement job end, Myntra/Meesho/mp invoice paths, and some clears — **not** from generic Flipkart order-only upload (usually fine).

---

## Ops: docs vs reality

| Topic | Docs | Code / CI |
|-------|------|-----------|
| Dev ports | START.bat, README | Frontend **5173**, API **3001** — matches |
| Prod | `docs/DEPLOY.md`, `docs/HOSTINGER_DEPLOY.md` | Unified `Dockerfile` + compose, Traefik 443, PG private `shared_infra`, `PG_SSL=false` on that path — matches intent |
| Health | `/health` | `backend/server.js`; Docker `HEALTHCHECK` hits `http://127.0.0.1:3001/health` |
| Statement timeout | SaaS baseline **90s** | Default **45s** (compose and Hostinger doc already 45s) |
| Rate card | “Python service” | Node in this repo |
| Split API/static Docker | Older leftover | Not what Hostinger workflow deploys |

CI deploys only from `master` after tests+build. There is no frontend test job and no lint job. That is acceptable until frontend regressions (role gates, allow-list) are covered.

---

## Script and test inventory (hygiene)

**Keep (ops):** `backend/scripts/backup-db.js`, `verify-postgres-runtime.js`, `analyze-postgres.js`, `activate-postgres.js`; root `scripts/db-tunnel.js`, `start-tunnel.bat`, `lan-ip.ps1`.

**Treat as scratch (delete or untrack):** `backend/scripts/test_*.js`, `check_*.js`, `peek_orders.js`, `explain_health.js`, `backend/test-visual.js`, `backend/routes/rateCard.js.bak`.

**Backend tests (62 files) — coverage clusters:** Amazon (~12), Myntra (~8), upload/Data Center (~8), settlement SQL shape (~4), outstanding/reconcile (~3), rate card/fees (~10), auth/routes (~5), DB transport (~4), parsers (~12+), static regressions (`codeantFollowup.test.js`).

**Frontend tests:** none.

---

## Suggested first three PRs (after this audit)

1. **Security hotfix:** H1 + H2 + gitignore/untrack C2 artifacts + redact C1 (no behavior change beyond authz/SQL binds).
2. **Settlement integrity:** H3 Meesho unique/replace + H4 drop Amazon synthetic view keys + M1 shared unsettled predicate + M5 clear-data totals refresh.
3. **Proof:** H5 Flipkart NEFT tests + `computeOutstandingMatrix` fixture tests + stop live PUT in outstanding tests.

Do not combine those with a `data.js` rewrite or a Python rate-card project.

---

*End of audit. This file is the only deliverable of the investigation.*
