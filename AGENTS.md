# Agent Guidelines & Project Memory

## TaskFlow Pro Integration (Mandatory Workflow)

All autonomous agents and coding assistants operating on this codebase must track and record their work on **TaskFlow Pro**.

### Lifecycle Rules:
1. **Start of Work**:
   - Call `sync_coding_work` on the `taskflow-pro` MCP server:
     - `project_name`: `"DashBorad Project"`
     - `task_title`: Specific title for the work item
     - `task_description`: Context and intended changes
     - `status`: `"in_progress"`
   - Save the returned `task.id` for all subsequent updates.
   - All tasks must be assigned to the connected user (**Pawan Shukla** / `returnorders@vbexports.co.in`).

2. **Progress Updates**:
   - Call `sync_coding_work` with `task_id` and `progress_note` as key milestones are reached.
   - Transition status to `"in_review"` when changes are ready for human verification or PR review.
   - Transition status to `"done"` once tests pass, database migrations run, and changes are verified.

3. **TaskFlow Server Details**:
   - Endpoint: `https://nekdjoquirhecmejuoba.supabase.co/functions/v1/mcp-server`
   - Configured in: `~/.gemini/config/mcp_config.json`
   - Web App UI: `https://task.youthnic.shop/`

## Marketplace Data Upload Architecture & Specifications

Whenever modifying, extending, or debugging data ingestion, orders, returns, settlements, or rate card mappings across any marketplace, **agents must strictly conform to [MARKETPLACE_DATA_UPLOAD_SPEC.md](MARKETPLACE_DATA_UPLOAD_SPEC.md)**.

### Core Architectural Invariants:
1. **Myntra Account Separation**:
   - `myntra_vb`: Seller ID `10708`
   - `myntra_ej`: Seller ID `45833`
   - Files with mismatched seller IDs must be rejected immediately with zero rows saved.
   - Blank tracking number rule: If tracking number is blank, order is marked `Cancelled` with `return_type = 'Courier Return'`, and a synthesized return (`Cancel Before Dispached`) is inserted into `returns`.
   - Return date resolution: If `return_created_date` is empty or 1970 epoch, fallback to `order_rto_date`.
2. **Amazon Pipeline**:
   - Zero synthetic keys: Never create synthetic `AMZ-{order_id}-{sku}` keys.
   - Flex returns column swap: file `SKU` = FNSKU; file `mSKU` = Merchant SKU (backend maps `mSKU -> sku` and `SKU -> fnsku`).
   - Settlement V2 join strategy: joins via `order_item_code` or `order_id` at query time; unlinked rows are non-order deductions.
   - Customer Return vs RTO: Customer returns retain FBA fulfillment fees and charge refund commission (-₹141.24 loss); RTO returns refund 100% of FBA fulfillment and closing fees via `Fulfillment Fee Refund` rows (net loss ~₹0).
   - Dynamic fee resilience: Store unknown fees in `other_fee` and full key-value maps in `fee_breakdown JSONB`.
   - Non-order segregation: Segregate storage, removal/disposal, and PPC advertising from order-level unit economics.
3. **Database Batching**:
   - Always batch multi-row inserts via `forEachDbBatch` to avoid PostgreSQL's 65,535 parameter limit.
   - Always invoke `refreshOrderSettlementTotals(pool)` after ingesting orders or settlement items.
4. **Automated Marketplace Discovery**:
   - Any new portal (Meesho, Ajio, Shopsy, etc.) uploaded into `orders`, or configured in `mp_config` / `marketplace_accounts`, automatically surfaces across the Outstanding Payments matrix and filter tabs without code changes.
   - Outstanding calculations strictly adhere to: `Total Orders - Returns - Marketplace Fees - Payment Received = Outstanding`.
5. **VB EXPORT SKU & Product Category Normalization Architecture**:
   - Master Product Key: `vb_export_sku` (e.g. `EJ1201-16001`) is our primary master product identifier across all marketplace channels.
   - Master Product Category: Disparate marketplace category taxonomies (e.g. Flipkart's "Women Kurtas", Myntra's "Kurta Sets", Amazon's "Apparel") must NEVER fragment the dashboard or reports. All category breakdowns, filters, and reports across Dashboard, Sales, and Profit Analysis must select, group, and filter by `COALESCE(o.vb_export_category, o.category, 'Uncategorized')`.
   - Master Catalog Management in `vb_sku_master`: COGS price and Weight Slabs are configured against the master `vb_export_sku` and cascade automatically to `sku_master` and `orders`.
   - Unmerged Listings Trigger: Any marketplace listing in `orders.sku` lacking a mapping to a `vb_export_sku` automatically triggers an alert banner and appears in the Unmerged Listings review queue with a 1-click merge workflow.
   - Master Catalog Upload Template: Downloadable template format strictly has columns: `Marketplace SKU`, `VB EXPORT SKU's`, `VB Export Product Category`, `Weight Slab (kg)`, `COGS (₹)`, `Marketplace`.
   - UI Layout & Anti-Clutter Rule: Strictly maintain 6 clean top-level tabs on Profit Analysis (`Overview`, `By Category`, `By SKU`, `By Account`, `By Zone`, `COGS & Weight Slabs`). Do NOT create redundant top-level tabs; use in-tab toggles or sub-tabs instead.

## Skills Roster (adopted from `msitarzewski/agency-agents`)

ReconCentral adopts the role-based skills from
[`msitarzewski/agency-agents`](https://github.com/msitarzewski/agency-agents).
The canonical roster, canonical-file mapping, and per-skill usage contract
live in [`docs/SKILLS.md`](docs/SKILLS.md). Sub-agents spawned for scoped
tasks MUST compose their prompt as
`<local context block> + <canonical skill body>` per the §3 procedure
in that file.

Primary 13 skills (mandatory for SOR + security + Notion work):
1. Frontend Developer (`engineering/engineering-frontend-developer.md`)
2. Backend Architect (`engineering/engineering-backend-architect.md`)
3. AI Engineer (`engineering/engineering-ai-engineer.md`)
4. DevOps Automator (`engineering/engineering-devops-automator.md`)
5. Senior Developer (`engineering/engineering-senior-developer.md`)
6. Code Reviewer (`engineering/engineering-code-reviewer.md`)
7. Software Architect (`engineering/engineering-software-architect.md`)
8. Data Engineer (`engineering/engineering-data-engineer.md`)
9. Email Intelligence Engineer (`engineering/engineering-email-intelligence-engineer.md`)
10. Database Reliability Engineer (`engineering/engineering-database-reliability-engineer.md`)
11. UI Designer (`design/design-ui-designer.md`)
12. UX Researcher (`design/design-ux-researcher.md`)
13. Analytics Reporter (`engineering/engineering-data-visualization-engineer.md` — closest upstream match; flagged for rename when upstream adds a closer role.)

## SOR Level Payment Reco Workspace

A new top-level workspace **SOR Level Payment Reco** (`/sor`) is
reserved for **invoice-level** reconciliation on top of the existing
order-level pipeline. Four portal sub-tabs:

| Sub-tab | Portal | Phase |
|---|---|---|
| `/sor/myntra-jabong` | Myntra Jabong India Private Limited | 1 — Excel parser (data source confirmed, sample pending) |
| `/sor/zepto` | Zepto Limited | 3 — Excel parser (data source confirmed, sample pending) |
| `/sor/reliance-ajio` | Reliance Retail Ltd (AJIO) | 2 — wire existing AJIO upload path (data source confirmed) |
| `/sor/cocoblu` | Cocoblu Retails | 4 — Excel parser (data source confirmed, sample pending) |

SOR-specific invariants:

- **Schema** lives in `sor_invoice` (header) + `sor_invoice_line`
  (line items) + `sor_upload_log` (audit), migrated by
  `ensureSorSchema()` in `backend/db/initDb.js` (versions
  `2026.10.sor-invoice-2`, `sor-ledger-2`, `sor-fk-dedupe-1`; the AJIO
  data backfill `sor-ajio-mirror-2` runs after the API is ready). Never
  reuse a version name whose contents changed. UNIQUE constraint is
  `(portal, portal_account, invoice_no, invoice_type)` so re-uploads are
  idempotent.
- **SOR migrations** run through `runVersionedMigration()` (one
  transaction, `lock_timeout`, version recorded only on success), run on
  both startup paths, and must **not** bump `CURRENT_SCHEMA_VERSION`
  (that sends production through the full DDL pass on the shared
  PostgreSQL server). Startup DDL only runs with `NODE_ENV=production` or
  `RUN_SCHEMA_MIGRATIONS=true`.
- **Referential integrity** — `sor_invoice_line.settlement_id` and
  `sor_invoice_line.order_row_id` are foreign keys to `settlements(id)`
  and `orders(id)` with `ON DELETE SET NULL` (one FK per column — the
  duplicate named FKs are dropped by `sor-fk-dedupe-1`), both indexed so
  the SET NULL actions never scan the table. Audit rows survive parent
  clears.
- **Audit integration** — `sor_upload_log` mirrors into `upload_log` via
  the `trg_sor_upload_log_mirror` AFTER INSERT trigger (function
  `sor_upload_log_mirror()`). `data_type='sor_invoice'` and
  `marketplace=portal` so existing Audit History queries surface SOR
  uploads with no code change.
- **Accounting ledger** — `sor_invoice_line.line_type` (CHECK
  constraint) is one of `sale | payment | return | deduction`. The
  `sor_outstanding` view computes
  `outstanding = sale − payment − return − deduction` per invoice and
  is the single source of truth for the per-portal KPI grid and the
  Outstanding Ledger UI. `variance = declared net_payable − (sale −
  return − deduction)` — payments never create variance. Sale lines
  link to `orders` via `order_row_id`; payment / return / deduction
  lines only need `invoice_id`. See
  [`docs/SOR_LEVEL_PAYMENT_RECO.md` §6a](docs/SOR_LEVEL_PAYMENT_RECO.md).
- **Line ownership** — `sor_invoice_line.source` names the pipeline that
  wrote a line (e.g. `mp_invoices:ajio`). A re-sync replaces only its own
  lines, never another stream's.
- **AJIO (Phase 2)** — the ledger is a derived read model of the stored
  AJIO `mp_invoices` rows (`services/sorMirror.js`), re-synced on every
  AJIO upload and delete; never build it from the in-flight file.
- **Upload streams** — invoice / payment / payment_advice / return /
  deduction for every portal through `services/sorUpload.js`
  (deterministic header aliases, no guessed values, per-row skip reasons).
  Every line carries `source_key`; `UNIQUE (invoice_id, line_type,
  source_key)` makes re-uploads idempotent, and payments are keyed
  `pay:<UTR>` everywhere (uploads and the AJIO mirror) so a payment is
  counted once. AJIO invoices only come through the AJIO importer. Uploads
  are operator / admin (`protectMutations('/api/sor')`).
- **Myntra** keeps the strict 10708 / 45833 split **only** for the
  regular Myntra marketplace pipeline (`myntraUpload.js`); MJIPL is a
  separate legal entity and **does not** use this gate.
- **All JSONB writes** must go through `forEachDbBatch`.
- **All settlement-line linkage** must trigger
  `refreshOrderSettlementTotals(pool)` after the write.
- **No top-level tab bloat** — SOR is a sibling workspace, not a tab
  inside Analytics. Its 4 sub-tabs are siblings, not nested, so
  cross-portal pivot keeps filter state.
- **Role gate** — SOR is `EXPORT_ROLES` (analyst, operator, admin)
  only. Viewers do not see the workspace in the Sidebar and direct
  URL access redirects to the Dashboard. Enforced both in
  `navigation.js` (`roles: EXPORT_ROLES`) and in `App.jsx` (per-route
  `hasRole(user.role, EXPORT_ROLES)` check on every `/sor/*` route).
- **Security** — every new portal onboarding (Zepto, Cocoblu, etc.)
  must complete the threat-model checklist in
  [`docs/SECURITY_AUDIT_2026-10-03.md`](docs/SECURITY_AUDIT_2026-10-03.md)
  before any code lands.

Full design: [`docs/SOR_LEVEL_PAYMENT_RECO.md`](docs/SOR_LEVEL_PAYMENT_RECO.md).

## Brand colour & contrast

The palette is rooted on brand burgundy `#902A4A` and lives in
`frontend/tailwind.config.js`.

- **Token pairs** — light `bg-primary-container` (#fbe9f0) takes
  `text-on-primary-container` (burgundy), never `text-on-primary`
  (white — unreadable). Dark surfaces (`bg-primary`, `indigo-dark`,
  the login hero, the calculator header) take `text-on-primary`.
- **No old indigo** — do not add `#3525cd` or `*-indigo-<n>` utilities;
  use brand tokens (`bg-primary`, `bg-primary-container/*`,
  `text-primary`). Existing light-indigo row highlights on Sales,
  Returns, Statement, Profit and a few other pages are a pending
  tonal sweep, not a contrast bug.
- **Focus ring** — `:focus-visible` in `frontend/src/index.css` uses
  `#902A4A`.

## Security Audit Cadence

- Every PR: AppSec + Code Reviewer skills.
- Monthly: `npm audit --omit=dev --audit-level=high`.
- Quarterly: full Security Audit doc refresh
  (`docs/SECURITY_AUDIT_YYYY-MM-DD.md`).
- On new portal onboarding: threat model + AppSec review BEFORE code.

Findings ledger lives in
[`docs/SECURITY_AUDIT_2026-10-03.md`](docs/SECURITY_AUDIT_2026-10-03.md).

## Agency-Agents Codebase Audit & Hardening (Completed & Verified)

In October 2026, the codebase underwent a full multi-skill audit and remediation pass across the Agency-Agents roster:

1. **AppSec Engineer & Security Architect**:
   - Purged tracked backup `backend/routes/rateCard.js.bak` from version control.
   - Hardened `.gitignore` to explicitly ignore `.runtime/`, `**/.runtime/`, `cookies.json`, and `**/cookies.json`.
   - Hardened `backend/services/rateCardScraper.js` to isolate Puppeteer session cookies inside `.runtime/cookies.json` with recursive directory creation, and replaced deprecated `page.waitForTimeout` with non-blocking `delay(ms)`.
2. **AI Engineer**:
   - Replaced obsolete/unsupported `gemini-2.5` model identifiers across `backend/routes/rateCard.js`, `backend/routes/statement.js`, and `backend/utils/dateNormalizer.js` with verified Google GenAI endpoints `['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro']`.
3. **Software Architect & Code Reviewer**:
   - Enforced the Master Product Category Normalization Invariant (`COALESCE(o.vb_export_category, o.category, 'Uncategorized')`) across `backend/routes/reconcile.js` (`unified-linkup` route and `buildFilters` SQL expression support), `backend/routes/rateCard.js` (distinct category discovery), and `backend/routes/export.js` (monthly detailed CSV/Excel exports).
4. **UI Designer & UX Researcher**:
   - Replaced disparate pink (`pink-50`, `pink-200`, `pink-600`) and dark navy (`#1a2b4c`, `#0f2744`) elements with brand burgundy tokens (`bg-primary`, `text-on-primary`, `bg-primary-container`, `text-primary`, `hover:bg-indigo-dark`) across `PaymentReconciliationPage.jsx` and `OutstandingPaymentsPage.jsx`.
   - Enforced the `text-on-primary` contrast standard on all dark burgundy buttons and badges.
5. **Frontend Developer**:
   - Configured Rollup `manualChunks` in `frontend/vite.config.js` (`react-vendor`, `firebase-vendor`, `charts-vendor`, `xlsx-vendor`), reducing entry bundle `index.js` by 73% (451 kB → 123 kB) with 4.63s build speed.
6. **DevOps Automator**:
   - Configured `NODE_OPTIONS: "--max-old-space-size=768"` under the container environment in `docker-compose.production.yml` to trigger V8 garbage collection before approaching the 1G cgroup limit, preventing Linux OOM-killer SIGKILL terminations.
7. **Database Connection Resilience & Disconnection Elimination**:
   - Implemented multi-directory cascade `.env` resolution in `backend/db/index.js` and `backend/server.js` (`../.env`, `../../.env`, `process.cwd()/.env`, `process.cwd()/backend/.env`) guaranteeing credentials load across all execution paths.
   - Expanded `isSafeReadStatement` to recognize Common Table Expressions (`WITH ... SELECT`) as safe read queries, preventing transient socket drops on CTE analytics queries from taking the pool offline.
   - Hardened `getPool().connect()` with a 2-attempt backoff retry loop to absorb transient WAN network resets before throwing `DatabaseUnavailableError`.
8. **UI/UX Minimalist Polish & Brand Design System**:
   - Completed full tonal sweep across all pages (`Sales`, `Returns`, `Statement`, `Profit Analysis`, `Upload`, `Amazon Reconcile`, `Amazon Rate Card`, `Order Detail Drawer`, `Export Button`, `Profit & Loss`, `Rate Audit`, and `Sidebar`), replacing all raw `indigo-*` classes with brand burgundy tokens (`bg-primary`, `bg-primary-container`, `text-primary`, `text-on-primary-container`, `border-primary/20`).
   - Enforced contrast compliance: `text-on-primary-container` on light pink containers; `text-on-primary` on dark burgundy surfaces.
9. **Marketplace Accounts Center & Desktop Scraper**:
   - Added AES-256-GCM encrypted credential storage for marketplace portals in `backend/routes/marketplaceAccounts.js`.
   - Integrated official SVG brand logos via Brandfetch MCP (Amazon, Cocoblu, Myntra, Flipkart, Reliance Retail / AJIO, Meesho, Shopify).
   - Built standalone Windows installer in `released/ReconCentral Desktop Setup 1.0.0.exe` with secure session management, role verification, and zero hardcoded database credentials.
10. **Cloudflare-Aligned API Security & Resilience Suite**:
   - Added `backend/tests/apiSecurityAndResilience.test.js` verifying 401 barriers on unauthenticated report/mutation access, sanitized health reporting without credential leakage, public vs internal projection isolation via `publicDatabaseStatus`, and graceful malformed JSON handling (400 without stack disclosure).
   - Enforced zero hardcoded secrets in test fixtures through dynamic `DATABASE_URL` credential inspection.

### Mandatory Review Gate: CodeAnt AI Review on All PRs
- **Branch & PR Workflow**: All feature work, fixes, and audits must be proposed via dedicated PR branches.
- **No Early Merging**: A PR must NEVER be merged until every commit and diff has been reviewed and verified by **CodeAnt AI**.
- **Test Integrity**: Full test suite (`npm test`, 84 files, 504 tests) and frontend build (`npm run build`) must pass 100% green before any PR review transition.



