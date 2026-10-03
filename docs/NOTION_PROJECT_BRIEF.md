# Notion Project Brief — VB Exports / ReconCentral

> **Status:** Draft for Pawan's review. This is the canonical content
> that should land in a Notion workspace page (under a "VB Exports /
> ReconCentral" parent page). Until the Notion integration is wired up
> in `~/.minimax`, copy this file into Notion manually, or grant the
> integration token so we can `mcp_invoke` it.

---

## Page 1 — Project Overview

**Title:** ReconCentral — Marketplace Finance Reconciliation

**Summary:**
ReconCentral is a multi-marketplace seller-finance dashboard for VB
Exports. It ingests orders, returns, settlements, and rate cards from
Flipkart, Amazon, Myntra (vb / ej), AJIO, Shopsy, and Meesho, and
computes reconciliation across the sale → bank → fee loop. Future
additions include invoice-level (SOR) reconciliation for Myntra Jabong,
Zepto, Reliance Retail / AJIO, and Cocoblu Retails.

**Repo:** https://github.com/pawanshukla500/DashBorad-Project
**Owner:** Pawan Shukla (`returnorders@vbexports.co.in`)
**Status:** Live, prod on Hostinger VPS via Docker

---

## Page 2 — Stack & Topologies

- **Frontend:** React 18 + Vite + Tailwind, lazy-loaded routes, design
  tokens (burgundy `#902A4A`, Inter + Geist + JetBrains Mono,
  tabular-nums on financial values).
- **Backend:** Node.js + Express + `pg`, idempotent migrations in
  `backend/db/initDb.js`, batched inserts via `forEachDbBatch`.
- **DB:** PostgreSQL (Docker on Hostinger VPS).
- **Auth:** Firebase Auth + custom role claim
  (`FIREBASE_ROLE_CLAIM`); roles `viewer / analyst / operator / admin`.
- **Hosting:** Hostinger VPS, Docker Compose, CI on GitHub Actions.

---

## Page 3 — Workspaces (Sidebar)

| Workspace | Purpose | Tabs |
|---|---|---|
| Control Center (`/`) | Daily actions, alerts, business health | Dashboard, Exception Inbox, Seller Intelligence |
| Sales (`/sales`) | What did I sell? | Sales Analysis |
| Returns (`/returns`) | What came back? | Returns Analysis, Return Tracking |
| Reconciliation (`/payments`) | Sale → bank → fee | Payment Check, Outstanding Payments, Statements, Order Linkup |
| Analytics (`/profit-loss`) | Margins & cash | P&L Summary, SKU Profitability, Cash Flow, Fee Calculator |
| Data & Setup (`/upload`) | Uploads, accounts, rate cards | Uploads, Rate Cards |
| **SOR Level Payment Reco** (`/sor`) *(new)* | Invoice-level reco | Myntra Jabong India Pvt Ltd, Zepto Limited, Reliance Retail Ltd (AJIO), Cocoblu Retails |
| Administration (`/admin-center`, admin only) | Users, charges, audit | Users & System, Charges, Amazon FCs, Audit History |

---

## Page 4 — Skills Roster (adopted from `msitarzewski/agency-agents`)

See [`docs/SKILLS.md`](SKILLS.md). The 13 primary skills are wired into
specific subsystems:

1. **Frontend Developer** — React + Vite + Tailwind pages/components
2. **Backend Architect** — Express services + route structure
3. **AI Engineer** — Email parsing, Gemini rate-card parser, auto-mapping
4. **DevOps Automator** — Hostinger Docker deploy, GitHub Actions
5. **Senior Developer** — Multi-file refactors + merges
6. **Code Reviewer** — Every PR
7. **Software Architect** — Cross-cutting invariants, IA changes
8. **Data Engineer** — Ingestion pipelines, batch rolls
9. **Email Intelligence Engineer** — Invoice email parsing
10. **Database Reliability Engineer** — Idempotent migrations, indexes
11. **UI Designer** — ReconCentral design system
12. **UX Researcher** — Operator + analyst journeys
13. **Analytics Reporter** — KPIs, insights cards, SOR overview

---

## Page 5 — Hard Invariants (from `AGENTS.md`)

1. **Myntra 10708 / 45833 split** — strict seller-ID gate before any
   row save; blank tracking → `Cancelled` + synthesised "Cancel Before
   Dispatched" return.
2. **Amazon** — no synthetic `AMZ-` keys; FNSKU ↔ SKU mapping honoured;
   Customer Return vs RTO fee accounting preserved.
3. **Database batching** — `forEachDbBatch` everywhere; call
   `refreshOrderSettlementTotals(pool)` after every order / settlement
   write.
4. **Marketplace discovery** — new portals auto-surface in Outstanding
   Payments matrix without code changes.
5. **vb_export_sku / vb_export_category** — master product keys
   (never use marketplace-specific taxonomy); cascade from
   `vb_sku_master`; Unmerged Listings trigger + 1-click merge UI.
6. **Profit Analysis** — exactly 6 top-level tabs; no extra top-level
   tabs.

---

## Page 6 — SOR Level Payment Reco (planned)

See [`docs/SOR_LEVEL_PAYMENT_RECO.md`](SOR_LEVEL_PAYMENT_RECO.md) for
the full design doc.

**What it adds:**

- New top-level workspace **"SOR Level Payment Reco"** with four
  portal sub-tabs:
  - **Myntra Jabong India Private Limited** (invoice-level on top of
    existing Myntra pipeline)
  - **Zepto Limited** *(data source TBD)*
  - **Reliance Retail Ltd (AJIO)** (invoice-level on top of AJIO
    pipeline)
  - **Cocoblu Retails** *(data source TBD)*
- New tables: `sor_invoice` (header) + `sor_invoice_line` (line items
  linking invoice ↔ order ↔ settlement).
- Per-portal reconciliation rules:
  `expected_net_payable = gross − returns − fees − tds`.
- Variance surfaced in the UI per invoice with drilldown to lines.

**Phases:**

- Phase 0 — Scaffold (workspace, sub-tabs, route stubs, migration).
- Phase 1 — Myntra end-to-end.
- Phase 2 — AJIO end-to-end.
- Phase 3 — Zepto end-to-end (Pawan's data source).
- Phase 4 — Cocoblu end-to-end (Pawan's data source).
- Phase 5 — Cross-portal insights.

---

## Page 7 — Security Audit Summary (2026-10-03)

See [`docs/SECURITY_AUDIT_2026-10-03.md`](SECURITY_AUDIT_2026-10-03.md)
for the full report.

**Findings (10 total, all Low/Medium, none Critical):**

- H1 — `requireRole` leaks role list in 403 body → sanitise message.
- H2 — `mutationAccessGuard` doesn't log denials → log to `audit_log`.
- H3 — No rate limit on `/upload` → add `express-rate-limit`.
- H4 — Filenames into `audit_log` not sanitised → strip control chars.
- H5 — Firebase web config in `VITE_FIREBASE_*` is *expected* (public);
  Admin SDK stays server-side.
- H6 — `START.bat` opens firewall globally → toggle + warning.
- H7 — No CSP / helmet → add `helmet()` strict CSP.
- H8 — No CORS preflight test → add `tests/corsSecurity.test.js`.
- H9 — No audit-log retention policy → 365-day nightly trim.
- H10 — No `npm audit --audit-level=high` CI gate → add + Dependabot.

**Fix PRs planned** — each follows branch-off-`master`, squash, delete,
CodeAnt follow-up.

---

## Page 8 — TaskFlow Integration

- Project: **DashBorad Project** (`ee11667b-fe64-4f33-9d07-b81c4ce1d99f`)
- Project UI: https://task.youthnic.shop/my-tasks
- Endpoint: `https://nekdjoquirhecmejuoba.supabase.co/functions/v1/mcp-server`
- Auth header: `tfp_pat_70446977b019aacb725dfaf4b486e92fe8f277610a805e5110814a9a45a8e620`
- All tasks assigned to Pawan (`9631e904-ebc6-4ea2-8481-7778e2c3c743`).
- Lifecycle: `in_progress` → `in_review` → `done`.

---

## Page 10 — Roadmap (next 6 weeks)

1. **SOR Phase 0** — Scaffold (PR open, in review).
2. **SOR Phase 1** — Myntra invoice-level end-to-end.
3. **Security Fix PRs** — H1–H4, H7, H10 (roll-up into 1–2 PRs).
4. **Zepto** data source confirmation + Phase 3.
5. **AJIO** invoice file parsing + Phase 2.
6. **Cocoblu** data source confirmation + Phase 4.
7. **Cross-portal insights** + quarterly security review.

---

## Action items (copy into Notion To-Do block)

- [ ] Pawan — confirm Myntra invoice file source/columns
- [ ] Pawan — confirm Zepto data source (Excel/email/SFTP)
- [ ] Pawan — confirm AJIO invoice file source
- [ ] Pawan — confirm Cocoblu data source
- [ ] Pawan — provide Notion integration token (optional — auto-sync)