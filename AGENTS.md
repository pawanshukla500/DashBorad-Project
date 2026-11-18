# Agent Guidelines & Project Memory

## 0. Mandatory Agent Bootstrap: graphify + ponytail

This section applies to **every** coding agent and assistant that touches this
repository, without exception: Claude Code (CLI, desktop, web), Codex, Gemini CLI
and Google Antigravity, Cursor, GitHub Copilot, Kimi, OpenCode, Devin, and every
subagent any of them spawns. A new agent that has never seen this project must
complete 0.1 **before any other work**, including TaskFlow sync, planning or code
reading. The in-depth guide (how it works, per-agent matrix, upgrades,
troubleshooting) is [`docs/AGENT_TOOLING.md`](docs/AGENT_TOOLING.md).

Two tools are mandatory:

| Tool | What it gives every agent | Upstream |
|---|---|---|
| **graphify** | A local, code-only knowledge graph of this repo (`graphify-out/`): symbols, call/import edges, communities, god nodes. Agents query it instead of grepping and reading whole files. | [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) (PyPI `graphifyy`, Apache-2.0) |
| **ponytail** | The "lazy senior dev" ruleset and skills: the smallest complete change, reuse before writing, and never cutting validation, error handling, security or accessibility. | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT) |

### 0.1 Session start (every session, every agent)

1. **First run on a machine, after pulling tooling changes, or whenever 0.1.2
   reports a problem:** `npm run agent:bootstrap` from the repository root. It:
   - installs or upgrades the graphify CLI (`graphifyy[sql]`, minimum version
     pinned in `scripts/agent-bootstrap.mjs`), trying `uv tool install`, then
     `pipx install`, then `python -m pip install`;
   - builds the graph on first run (`graphify extract . --code-only`, then
     `graphify cluster-only . --no-label`) or refreshes it incrementally
     (`graphify update .`), always with `GRAPHIFY_BACKEND=none`;
   - installs graphify's git hooks (graph rebuilds after commit, checkout,
     merge and rebase; `--no-hooks` skips this);
   - restores missing project skills (`graphify install --project`);
   - installs the ponytail plugin into every agent CLI it finds on `PATH`
     (Gemini CLI, Codex, Copilot CLI; `--no-plugins` skips this).
2. **Every session:** `npm run agent:check` must exit 0. Claude Code runs the
   same check automatically (`node scripts/agent-bootstrap.mjs --session`
   from the `SessionStart` hook in `.claude/settings.json`), which also
   refreshes the graph.
3. **Ponytail per agent:**
   - Claude Code: the plugin is declared in `.claude/settings.json`
     (`extraKnownMarketplaces` + `enabledPlugins`); accept the install prompt
     when the folder is trusted, or type `/plugin marketplace add DietrichGebert/ponytail`
     and then `/plugin install ponytail@ponytail` as two separate prompts.
   - Gemini CLI / Antigravity: `gemini extensions install https://github.com/DietrichGebert/ponytail`
     (Antigravity CLI: `agy plugin install https://github.com/DietrichGebert/ponytail`).
   - Codex: `codex plugin marketplace add DietrichGebert/ponytail` and
     `codex plugin add ponytail@ponytail`, then trust its hooks under `/hooks`.
   - Every other agent: the ruleset in 0.3 below plus the vendored skills in
     `.agents/skills/ponytail*/` and `.agents/rules/ponytail.md` (Cursor:
     `.cursor/rules/ponytail.mdc`).
4. An agent that cannot run shell commands must still follow 0.2–0.4 by hand
   and state in its reply that the bootstrap could not be run.
5. Hooks are a convenience, never the guarantee: a user setting such as
   `"disableAllHooks": true` turns them off. These written rules bind every
   agent regardless.

### 0.2 graphify: graph first, then targeted reads

- Before the first grep, search or file read for any codebase question, query
  the graph: `graphify query "<question>"`, `graphify explain "<symbol>"`,
  `graphify path "<A>" "<B>"`, `graphify affected "<symbol>"` (what a change
  breaks), `graphify god-nodes` (architectural hubs). Read raw files only for
  the lines the graph located. Put this rule into every subagent prompt that
  explores code.
- `graphify-out/GRAPH_REPORT.md` is for broad architecture review;
  `graphify-out/graph.html` is the interactive map for humans.
- **Privacy (non-negotiable):** this repository is public and its history holds
  business data. Build the graph code-only and offline:
  `GRAPHIFY_BACKEND=none`, `--code-only`. Never run a graphify LLM backend,
  `--mode deep`, `graphify add <url>` or the semantic `/graphify` pass over
  docs on this repo, and never commit `graphify-out/` (it is git-ignored).
- `.graphifyignore` keeps scratch, build output, binaries and spreadsheets out
  of the graph; update it when a new generated or local-only folder appears.
- After modifying code, refresh the graph: `npm run graph:update` (or
  `graphify update .`). Stale graph files are never a reason to skip graphify.

### 0.3 Ponytail ruleset (always on)

The rules below are Ponytail's agent ruleset, vendored from
[DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) at commit
`96608e078b2d5ea607c5c3b8b5a54d1c1fba6846` (MIT, copyright 2026 DietrichGebert;
licence in `.agents/skills/ponytail/LICENSE`). They apply to every change in
this repo. Where a project invariant elsewhere in this file is stricter (data
integrity, security, migrations, brand tokens, the review gate), the invariant
wins; Ponytail never removes a check.

You are a lazy senior developer. The best code is the code never written. You
solve the whole problem with the least new code. End your reply with one or two
lines: what you skipped or did not check, and any risk the user must know.

#### Before you write

Read the task and the code it touches. List every place your change must reach:
callers, tests, fixtures, config, exports. Check what your change could break for
users: data it would destroy or expose, callers that stop working. That is
scope. Extra features are not.

#### The smallest complete change

Take the first option that fully works:

1. Does it need to exist? Skip features, options and flexibility nobody asked
   for, and name them in one line. A vague request ("build me X") gets the
   smallest version that does the core job.
2. Already in this codebase (a helper, component, service, pattern)? Use it the
   way the surrounding code does.
3. Standard library or a platform feature? Use it, unless the project has its
   own. A house component beats a native widget.
4. An installed dependency? Use it. Never add a dependency for a few lines.
5. Can it be one line a reader gets at a glance? One line.
6. Otherwise: the minimum code that works.

- Be lazy about the solution, never about the change itself: finish every part
  the task needs, including the callers, tests and fixtures your change breaks.
- No abstraction, wrapper, type conversion, option, config, boilerplate or "for
  later" code nobody asked for. Keep values in the form the platform already
  gives you. Deletion beats addition. Keep the structure the codebase already
  has: its layers, interfaces and conventions.
- The shortest working diff wins, once you know everything it must touch. A
  one-liner that needs decoding is not short.
- Comment only the why the code cannot show, in one line.
- Bug fix: before you edit, grep every caller of the function you touch (start
  with `graphify affected "<function>"`), then fix the root cause once in the
  shared code.
- Code you move or merge keeps its error handling and validation.
- Between options of equal size, take the one that is correct on edge cases.
- Lazy code without its check is unfinished: new non-trivial logic (a branch, a
  loop, a parser, money or security, or a whole new script or app) leaves one
  small test or an assert-based self-check. Trivial changes need none.
- A shortcut with a known limit gets a code comment in this form:
  `shortcut: <the limit>, <when to upgrade>`.

Never cut: validation at trust boundaries, error handling that prevents data
loss, security, accessibility, the calibration real hardware needs, anything
the user asked for.

Ponytail skills (in the Claude Code plugin and in `.agents/skills/`):
`/ponytail` (levels `lite`, `full`, `ultra`, `off`), `/ponytail-review`
(review a change, including the code it touches outside the diff),
`/ponytail-audit` (rank the whole repo's risks), `/ponytail-debt`,
`/ponytail-gain`, `/ponytail-help`.

### 0.4 Keep project context and documentation current (every change)

Context and docs are part of the change, not a follow-up. Before a task is
reported done or a PR is opened:

1. **Graph:** `npm run graph:update` so the next agent queries current code.
2. **Core memory:** update this file (and mirror it in `GEMINI.md`) when an
   invariant, architecture rule, workflow, schema rule or command changes, and
   keep the test counts in the review gate accurate.
3. **Docs:** update the doc that owns the area (`docs/ARCHITECTURE.md`,
   `MARKETPLACE_DATA_UPLOAD_SPEC.md`, `docs/SOR_LEVEL_PAYMENT_RECO.md`, the
   relevant audit ledger, `docs/AGENT_TOOLING.md`, `README.md`); a new
   subsystem gets its own doc, linked from `README.md` and
   `docs/ARCHITECTURE.md`.
4. **PR:** the description lists which context and doc files changed, or
   states why none needed to. A behaviour change without its doc update is not
   ready for review. The agent then runs the review, fix and merge loop of the
   review gate (near the end of this file) until the PR is merged.
5. **Tooling versions:** when graphify or ponytail is upgraded, update
   `MIN_GRAPHIFY_VERSION` in `scripts/agent-bootstrap.mjs`, the vendored
   ponytail files and the commit in 0.3, following `docs/AGENT_TOOLING.md`.

### 0.5 Files that implement this section

| File | Purpose |
|---|---|
| `scripts/agent-bootstrap.mjs` | Bootstrap / check / session script (`npm run agent:bootstrap`, `agent:check`, `graph:update`) |
| `.claude/settings.json` | Claude Code: ponytail marketplace + plugin, `SessionStart` bootstrap check, graphify `PreToolUse` guards |
| `.claude/skills/graphify/` | graphify skill for Claude Code (`graphify install --project`) |
| `.agents/skills/graphify/`, `.agents/skills/ponytail*/`, `.agents/rules/ponytail.md` | Agent Skills / rules for Codex and other spec-compliant agents |
| `.gemini/settings.json` | Gemini CLI `BeforeTool` graphify guard |
| `.cursor/rules/graphify.mdc`, `.cursor/rules/ponytail.mdc` | Cursor always-on rules |
| `.github/copilot-instructions.md` | VS Code Copilot Chat instructions |
| `.graphifyignore` | What the graph leaves out |
| `GEMINI.md` | Mirror of this section for Gemini CLI / Antigravity |
| `docs/AGENT_TOOLING.md` | Full guide |

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
   - Standardized interactive buttons, header surfaces, and primary containers across core views (Statement, Profit Analysis, Upload, Amazon Reconcile, Amazon Rate Card, Export Button, Profit & Loss, Rate Audit, and Sidebar) to brand burgundy tokens (`bg-primary`, `bg-primary-container`, `text-primary`, `text-on-primary-container`, `border-primary/20`), preserving table-row accent highlights on data-dense tables per the pending tonal sweep guideline.
   - Enforced contrast compliance: `text-on-primary-container` on light pink containers; `text-on-primary` on dark burgundy surfaces.
9. **Marketplace Accounts Center & Desktop Scraper**:
   - Added AES-256-GCM encrypted credential storage for marketplace portals in `backend/routes/marketplaceAccounts.js`.
   - Integrated official SVG brand logos via Brandfetch MCP (Amazon, Cocoblu, Myntra, Flipkart, Reliance Retail / AJIO, Meesho, Shopify).
   - Built standalone Windows installer in `released/ReconCentral-RateCard-Worker-Setup.exe` (and portable build `ReconCentral-RateCard-Worker-Portable.exe`) with secure session management, role verification, and zero hardcoded database credentials.
10. **Cloudflare-Aligned API Security & Resilience Suite**:
   - Added `backend/tests/apiSecurityAndResilience.test.js` verifying 401 barriers on unauthenticated report/mutation access, sanitized health reporting without credential leakage, public vs internal projection isolation via `publicDatabaseStatus`, and graceful malformed JSON handling (400 without stack disclosure).
   - Enforced zero hardcoded secrets in test fixtures through dynamic `DATABASE_URL` credential inspection.
11. **Desktop Worker & RateCard Extension Architecture**:
   - **Self-Contained ASAR Packaging**: Desktop application files in `desktop/` are packaged into an ASAR archive. Code must never import from `../backend/` via relative paths (causes `ERR_MODULE_NOT_FOUND` in packaged production). Backend dependencies are either isolated in `desktop/` (e.g. `desktop/cookieVault.js`) or dynamically loaded with graceful fallback `.catch(() => null)`.
   - **Release Directory Integrity**: All built installer binaries, portable executables, and Linux installation packages strictly reside in `released/` (`released/ReconCentral-RateCard-Worker-Setup.exe`, `released/ReconCentral-RateCard-Worker-Portable.exe`, `released/linux/install-linux.sh`). The typo directory `relased/` is permanently prohibited.
   - **Database Query & Mutation Extension Engine (`desktop/db.js`)**:
     - Exposes parameterized, SQL-injection-safe data access via `downloadTableDetails` and `uploadTableUpdates`.
     - Strictly restricted to allowlisted tables: `orders`, `returns`, `settlements`, `rc_commission`, `rc_fixed_fee`, `rc_collection_fee`, `rc_reverse_shipping`, `rate_card_versions`, `sku_master`, `vb_sku_master`.
     - Identifier validation enforces `/^[a-zA-Z_][a-zA-Z0-9_]*$/` for all tables, columns, and sort keys.
     - Role-gated: Read/Query operations require `isAuthorizedDesktopRole` (`admin`, `operator`, `analyst`); mutations require `isAuthorizedMutationRole` (`admin`, `operator`).
     - PostgreSQL parameter limit: All batch upserts are chunked to prevent exceeding the 65,535 parameter limit.
   - **Rate Card Auto-Closure Invariant**: When syncing scraped rate cards starting on `new_start_date`, prior active records (`end_date IS NULL` or `end_date >= new_start_date`) for the matching category, marketplace, and seller account must be auto-closed with `end_date = dayBefore(new_start_date)` to satisfy the database check constraint `(end_date IS NULL OR end_date >= start_date)`.
   - **Shopsy Rate Invariant**: Shopsy marketplace commission is strictly 0.00% across all product verticals and order values.
   - **Cross-Platform Security & Permissions**:
     - Credentials and session tokens are never hardcoded in installer bundles; dynamically provisioned over TLS upon Firebase Auth role verification.
     - Session cookies are encrypted at rest with AES-256-GCM using hardware-derived keys.
     - Linux daemon and directories strictly enforce `0700` directory permissions and `0600` config file permissions (`/etc/reconcentral-ratecard/worker-config.json`).
     - Systemd service `reconcentral-ratecard.service` runs in `/opt/reconcentral-ratecard/` with automatic respawn and isolation.
12. **Marketplace Fee Monitoring, Dual Anomaly Detection & Versioning Architecture**:
    - **Full Parameter Extraction Coverage**: Validates all fee components (commissions, fixed/closing fees, collection fees, reverse shipping, and FBF pick & pack) fail-closed. Enforces Shopsy 0.00% commission invariant across all verticals.
    - **Dual Comparison Engine**: Compares newly extracted rate cards against both (1) the last successfully validated extraction snapshot in `rate_card_extractions`, and (2) active PostgreSQL rates (`end_date IS NULL`). Automatically tracks and bridges multi-day gaps when extraction days are skipped.
    - **Non-Overlapping Contiguous Versioning**: When changes are published, prior published rate card records are automatically closed with `effective_to = dayBefore(new_effective_from)` and `status = 'archived'`. Uncommitted draft records are strictly preserved.
    - **Admin Alerts & Error Containment**: Automated dual notification via Resend Email and WhatsApp reporting fee shifts, absolute and percentage diffs, previous/new versions, and validation status, backed by persistent delivery logging in `rate_card_notification_log`.
    - **FBF Pick & Pack Invariant**: Warehouse units (FBF) incur pick & pack fees; non-FBF seller fulfillment is strictly ₹0.
    - **Missing Excel Auto-Generation**: `/api/open-excel` automatically generates `Flipkart_Shopsy_Brandwise_RateCard.xlsx` on demand from active database rates if absent from disk.
    - **Automated GitHub Releases**: Desktop installer releases publish versioned Windows installer (`ReconCentral-RateCard-Worker-Setup-X.Y.Z.exe`), auto-update metadata (`latest.yml`, `.blockmap`), and Linux AppImage on tag push and manual workflow dispatch.

### Mandatory Review Gate: CodeAnt AI Review, then Automatic Merge
- **Branch & PR Workflow**: All feature work, fixes, and audits must be proposed via dedicated PR branches. A PR built on another open PR says so in its title ("stacked on #N").
- **Review, fix, merge (owner-authorised 2026-11-18)**: the agent that opens or updates a PR carries it through to the merge itself, without waiting to be asked:
  1. After every push, wait for all CI checks to finish (`gh pr checks <n> --watch`).
  2. Wait for **CodeAnt AI** to review the latest commit (its "Review Status" and "PR Risk" comments). If it has not started within 15 minutes, comment `@codeant-ai review`. CodeRabbit does not review this repo automatically; comment `@coderabbitai review` for a second opinion.
  3. Fix every actionable finding (CodeAnt, CodeRabbit, a human reviewer, a failed check) in a new commit, or reply on the PR with why it does not apply. Then go back to step 1.
  4. Merge with `gh pr merge <n> --squash` once all of these hold: every check passes, CodeAnt has reviewed the PR and rates it low risk or every finding is fixed or answered, no human review comment is unanswered, and the branch is mergeable. Stacked PRs merge bottom-up, each after the one below it.
- **No Early Merging**: A PR must NEVER be merged before step 4 holds. A failing check, an unanswered finding or a missing CodeAnt review blocks the merge.
- **Merging is not deploying**: a push to `master` only runs CI. Production (Hostinger) deploys only through a manual `workflow_dispatch` of `.github/workflows/deploy-hostinger.yml`.
- **Test Integrity**: Full backend test suite (`cd backend && npm test`; on `master` as of 2026-11-18: 96 files, 701 tests, of which 1 file / 8 tests are skipped) and frontend build (`cd frontend && npm run build`) must pass 100% green before any PR review transition. Keep these counts current (section 0.4).

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. When the answer is under a Markdown heading, `graphify section "<heading>"` prints that section's text, so the .md need not be opened. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
