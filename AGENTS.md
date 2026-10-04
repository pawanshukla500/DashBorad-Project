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
  (line items) + `sor_upload_log` (audit). Idempotent migration
  `2026.10.sor-ledger-1` (current; supersedes `2026.10.sor-invoice-1`)
  is wired into `backend/db/initDb.js`.
  UNIQUE constraint is `(portal, portal_account, invoice_no, invoice_type)`
  so re-uploads are idempotent.
- **Referential integrity** — `sor_invoice_line.settlement_id` and
  `sor_invoice_line.order_row_id` are foreign keys to `settlements(id)`
  and `orders(id)` with `ON DELETE SET NULL`. Constraints are added
  idempotently by `ensureSorInvoiceSchema()` for installs that pre-date
  the FK declarations. Audit rows survive parent clears.
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
  Outstanding Ledger UI. Sale lines link to `orders` via
  `order_row_id`; payment / return / deduction lines only need
  `invoice_id`. See [`docs/SOR_LEVEL_PAYMENT_RECO.md` §6a](docs/SOR_LEVEL_PAYMENT_RECO.md).
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

## Security Audit Cadence

- Every PR: AppSec + Code Reviewer skills.
- Monthly: `npm audit --omit=dev --audit-level=high`.
- Quarterly: full Security Audit doc refresh
  (`docs/SECURITY_AUDIT_YYYY-MM-DD.md`).
- On new portal onboarding: threat model + AppSec review BEFORE code.

Findings ledger lives in
[`docs/SECURITY_AUDIT_2026-10-03.md`](docs/SECURITY_AUDIT_2026-10-03.md).



