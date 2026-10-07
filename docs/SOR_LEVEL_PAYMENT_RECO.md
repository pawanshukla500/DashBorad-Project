# SOR Level Payment Reconciliation — Design Doc

**Status:** Live — ledger, AJIO mirror, upload streams for all four portals, statement + ledger report
**Owner:** Pawan Shukla
**Last updated:** 2026-10-07

---

## 1. Why this exists

Today ReconCentral reconciles at **order level** (orders → returns →
marketplace fees → payments received = outstanding). For four of our
key portals we need a tighter grain: **invoice level**. Each
marketplace issues invoices with their own numbering, fee headers, and
TDS / reverse-charge rules, and the same Order ID can appear across
multiple invoices when a return settles on a different invoice than
the original sale.

This doc captures the design for a new top-level workspace
**"SOR Level Payment Reco"** with sub-tabs per portal.

---

## 2. Portal sub-tabs

Each portal is its own sub-tab. Sub-tabs are siblings, not nested, so
the operator can pivot between portals without losing filter state.

| Sub-tab | Portal (legal name) | Reconciliation grain | Data source(s) | Confirmed? |
|---|---|---|---|---|
| `Myntra Jabong India Private Limited` | Myntra Jabong India Pvt Ltd — **separate legal entity** (per Pawan, 2026-10-03). Not a seller-account variant of the regular Myntra marketplace. | Invoice + Order | **Excel upload from seller portal** (confirmed 2026-10-03). Separate seller portal, separate file format, separate fee/TDS/GST rules. | ✅ (Phase 1 — parser pending sample) |
| `Zepto Limited` | Zepto Ltd | Invoice + Order | **Excel upload from seller portal** (confirmed 2026-10-03) | ✅ (Phase 3 — parser pending sample) |
| `Reliance Retail Ltd (AJIO)` | Reliance Retail Ltd | Invoice + Order | **Separate AJIO invoice upload path** (confirmed 2026-10-03) — Phase 2 = wire existing AJIO upload path into `sor_invoice` | ✅ (Phase 2) |
| `Cocoblu Retails (Cocoblu)` | Cocoblu Retails | Invoice + Order | **Excel upload from seller portal** (confirmed 2026-10-03) | ✅ (Phase 4 — parser pending sample) |

> ⚠️ The **regular Myntra marketplace** (10708 vb / 45833 ej) is NOT a
> sub-tab of the SOR workspace. It is supported through the existing
> pipeline. The SOR workspace is for the four portals above only.
>
> ⚠️ **Myntra Jabong India Private Limited** is, per Pawan, a wholly
> separate entity from the regular Myntra pipeline — different files,
>
> different portal, different rules. It does NOT use the 10708 / 45833
> seller-ID gate. The MJIPL invoice pipeline is independent.

---

## 3. Workspace shape (navigation)

```
WORKSPACES
└── sor (new)
    ├── label: "SOR Level Payment Reco"
    ├── description: "Invoice-level reconciliation across key portals"
    ├── paths: ["/sor", "/sor/myntra-jabong", "/sor/zepto", "/sor/reliance-ajio", "/sor/cocoblu"]
    └── tabs:
        ├── { path: "/sor/myntra-jabong", label: "Myntra Jabong India Private Limited" }
        ├── { path: "/sor/zepto",         label: "Zepto Limited" }
        ├── { path: "/sor/reliance-ajio", label: "Reliance Retail Ltd (AJIO)" }
        └── { path: "/sor/cocoblu",       label: "Cocoblu Retails" }
```

`/sor` itself redirects to `/sor/myntra-jabong` (the largest portal).

**Role gate (Phase 0):** SOR is `EXPORT_ROLES` (analyst, operator, admin)
only. Viewers do not see the workspace in the Sidebar; direct URL
access redirects to the Dashboard). Enforced both in
`frontend/src/navigation.js` (`roles: EXPORT_ROLES`) and in
`frontend/src/App.jsx` (per-route `hasRole(user.role, EXPORT_ROLES)`
check on every `/sor/*` route).

---

## 4. Invoice-level schema (live in Phase 0)

Phase 0 (PR #42) created these tables; `backend/db/initDb.js` is the
single source of truth — reproduced below for reference, including the
Phase 0.5 columns (`line_type`, `source`). See §6a for the migration
versions and how they run.

```sql
-- Header per portal invoice
CREATE TABLE IF NOT EXISTS sor_invoice (
  id              BIGSERIAL PRIMARY KEY,
  portal          TEXT NOT NULL,
  portal_account  TEXT NOT NULL DEFAULT 'default',
  invoice_no      TEXT NOT NULL,
  invoice_date    DATE,
  period_from     DATE,
  period_to       DATE,
  invoice_type    TEXT NOT NULL,
  gross_amount    NUMERIC(14,2),
  fee_amount      NUMERIC(14,2),
  tds_amount      NUMERIC(14,2),
  net_payable     NUMERIC(14,2),
  raw_payload     JSONB NOT NULL,
  uploaded_by     TEXT,
  uploaded_at     TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_sor_invoice_portal_account_no_type UNIQUE (portal, portal_account, invoice_no, invoice_type)
);

-- Line items linking invoice ↔ order ↔ settlement.
-- settlement_id and order_row_id are FK references with ON DELETE SET NULL
-- so clearing the parent settlement or order preserves the audit row.
-- line_type is the SOR accounting-ledger discriminator: 'sale' | 'payment' | 'return' | 'deduction'.
-- source is the lineage of the line (e.g. 'mp_invoices:ajio'); a re-sync
-- replaces only the lines its own pipeline owns.
CREATE TABLE IF NOT EXISTS sor_invoice_line (
  id              BIGSERIAL PRIMARY KEY,
  invoice_id      BIGINT NOT NULL REFERENCES sor_invoice(id) ON DELETE CASCADE,
  line_type       TEXT NOT NULL DEFAULT 'sale',
  order_id        TEXT,
  sku             TEXT,
  vb_export_sku   TEXT,
  quantity        INT,
  gross_amount    NUMERIC(14,2),
  fee_amount      NUMERIC(14,2),
  settlement_id   BIGINT REFERENCES settlements(id) ON DELETE SET NULL,
  order_row_id    BIGINT REFERENCES orders(id)      ON DELETE SET NULL,
  raw_payload     JSONB NOT NULL,
  source          TEXT,
  CONSTRAINT sor_invoice_line_line_type_check
    CHECK (line_type IN ('sale', 'payment', 'return', 'deduction'))
);

-- Audit trail per uploaded file.
CREATE TABLE IF NOT EXISTS sor_upload_log (
  id            SERIAL PRIMARY KEY,
  portal        TEXT NOT NULL,
  portal_account TEXT NOT NULL DEFAULT 'default',
  filename      TEXT,
  rows_inserted INT DEFAULT 0,
  rows_updated  INT DEFAULT 0,
  rows_skipped  INT DEFAULT 0,
  status        TEXT,
  error_msg     TEXT,
  remark        TEXT,
  uploaded_by   TEXT,
  uploaded_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 7 covering indexes shipped with Phase 0:
-- IX_sor_invoice_portal        ON sor_invoice(portal, portal_account)
-- IX_sor_invoice_date          ON sor_invoice(invoice_date DESC)
-- IX_sor_invoice_period        ON sor_invoice(period_from, period_to)
-- IX_sor_invoice_line_order    ON sor_invoice_line(order_id) WHERE order_id IS NOT NULL
-- IX_sor_invoice_line_sku      ON sor_invoice_line(vb_export_sku) WHERE vb_export_sku IS NOT NULL
-- IX_sor_invoice_line_invoice  ON sor_invoice_line(invoice_id)
-- IX_sor_upload_log_portal_date ON sor_upload_log(portal, uploaded_at DESC)
-- Phase 0.5 (ensureSorLedgerSchema):
-- IX_sor_invoice_line_invoice_cover ON sor_invoice_line(invoice_id) INCLUDE (line_type, gross_amount)
-- IX_sor_invoice_line_order_row     ON sor_invoice_line(order_row_id)  WHERE order_row_id IS NOT NULL
-- IX_sor_invoice_line_settlement    ON sor_invoice_line(settlement_id) WHERE settlement_id IS NOT NULL
```

### Audit mirror trigger (Phase 0)

Every `sor_upload_log` row is mirrored into `upload_log` via the
`trg_sor_upload_log_mirror` AFTER INSERT trigger (function
`sor_upload_log_mirror()`). The mirror row uses `marketplace=portal`
(e.g. `'myntra'`, `'zepto'`) and `data_type='sor_invoice'`, so the
existing Audit History query surfaces SOR uploads alongside marketplace
uploads with **no** Audit History code change.

```sql
CREATE OR REPLACE FUNCTION sor_upload_log_mirror() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO upload_log (
    data_type, filename, marketplace, rows_inserted, rows_updated,
    rows_skipped, status, error_msg, remark, uploaded_at
  ) VALUES (
    'sor_invoice', NEW.filename, NEW.portal, NEW.rows_inserted,
    NEW.rows_updated, NEW.rows_skipped, NEW.status, NEW.error_msg,
    COALESCE(NEW.remark, '') || ' | portal_account=' || NEW.portal_account,
    NEW.uploaded_at
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sor_upload_log_mirror
  AFTER INSERT ON sor_upload_log
  FOR EACH ROW EXECUTE FUNCTION sor_upload_log_mirror();
```

### FK constraint hardening

For installs that pre-date the FK references in `sor_invoice_line`,
`ensureSorInvoiceSchema()` adds the constraints idempotently using a
`pg_constraint` lookup guard:

```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_sor_invoice_line_settlement'
  ) THEN
    ALTER TABLE sor_invoice_line
      ADD CONSTRAINT fk_sor_invoice_line_settlement
      FOREIGN KEY (settlement_id) REFERENCES settlements(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_sor_invoice_line_order'
  ) THEN
    ALTER TABLE sor_invoice_line
      ADD CONSTRAINT fk_sor_invoice_line_order
      FOREIGN KEY (order_row_id) REFERENCES orders(id) ON DELETE SET NULL;
  END IF;
END $$;
```

All `JSONB` writes go through `forEachDbBatch` and any change to
`orders` / `settlements` triggers `refreshOrderSettlementTotals`
(per AGENTS.md invariants).

---

## 5. SOR reconciliation rules (per portal)

### 5.1 Myntra Jabong India Private Limited

- **This is a separate legal entity** from the regular Myntra marketplace
  (which uses the 10708 / 45833 split). MJIPL has its own seller-ID model
  (single account or multi-brand — to be confirmed during Phase 1).
- **No 10708 / 45833 gate applies** here. The strict Myntra-vb / Myntra-ej
  split used by `myntraUpload.js` is intentionally NOT used; MJIPL
  invoices flow into `sor_invoice` directly with `portal_account` set to
  MJIPL's own account identifier.
- For each `sor_invoice` (type = `settlement`):
  - Sum `gross_amount` (sale side) → `sum_orders_gross`.
  - Sum `gross_amount` (return side) → `sum_returns_gross`.
  - Sum `fee_amount` → `sum_marketplace_fee`.
  - Sum `tds_amount` → `sum_tds`.
  - Expected `net_payable` = `sum_orders_gross - sum_returns_gross - sum_marketplace_fee - sum_tds`.
  - Variance vs declared `net_payable` flagged in the UI as
    `invoice_variance`.
- Linked orders (`sor_invoice_line.order_row_id`) cross-check against
  `orders.net_payable` — show per-order deltas.

### 5.2 Zepto Limited

- TBD — Pawan to confirm:
  - Portal account identifier(s)
  - File source (Excel? Email PDF? SFTP?)
  - Invoice number pattern
  - Fee / TDS / reverse-charge rules

### 5.3 Reliance Retail Ltd (AJIO)

- AJIO invoice file has its own column layout (not Myntra's).
- `portal_account` = `ajio_main` until Pawan confirms multi-account
  split.
- Reconciliation = sum of `sor_invoice.net_payable` for the period
  vs `settlement_items.amount` for matching order IDs.

### 5.4 Cocoblu Retails

- TBD — Pawan to confirm:
  - Portal account identifier(s)
  - File source
  - Invoice columns
  - Any fee/commission lines that don't appear on other portals

---

## 6. UI shell (per sub-tab)

Each sub-tab page reuses the existing ReconCentral design system:

```
[ PageHeader ] "SOR · Myntra Jabong India Private Limited"
[ PortalFilter ] (account, date range, invoice status)
[ KPI grid ]
  · Invoices count
  · Variance vs settlement (₹)
  · Unsettled invoices
  · Last upload (timestamp)
[ Invoice table ] (search, sort, paginate, export to xlsx)
  · InvoiceNo · Type · Gross · Fee · TDS · Net · Status · Action (Drilldown)
[ Drilldown drawer ]
  · Header (invoice metadata)
  · Linked orders
  · Variance detail
```

Design tokens stay on-brand (burgundy `#902A4A`, Inter + Geist +
JetBrains Mono, tabular-nums on financial values).

As built (`frontend/src/pages/Sor/SorPageShell.jsx`): KPI tiles
(outstanding, invoices, overdue > 60 days, invoices with variance, last
upload), the sale − payment − return − deduction breakdown, open
outstanding by age (0–30 / 31–60 / 61–90 / 90+ days), the four upload
streams with their real status, the Outstanding Ledger (server-side
invoice search, status filter, sortable columns, 50-row pages, honours the
global date filter and Refresh), and the invoice drilldown (accessible
`Modal`, lines grouped by type, fee type / payment reference labels).
Upload links are shown to operators and admins only; analysts see who
uploads instead of a link that would bounce them off `/upload`.

---

## 6a. Accounting ledger (`sor_outstanding`)

Every SOR line is one of four streams (`sor_invoice_line.line_type`):
`sale`, `payment`, `return`, `deduction`. All amounts live in
`gross_amount` (deduction lines too; `fee_amount` is 0 on ledger lines).
The `sor_outstanding` view is the single source of truth for the KPI grid
and the ledger table — one row per `sor_invoice`:

| Column | Definition |
|---|---|
| `sale_total` / `payment_total` / `return_total` / `deduction_total` | Σ `gross_amount` per `line_type` (0 when a stream has no lines) |
| `outstanding` | `sale − payment − return − deduction` |
| `expected_net_payable` | `sale − return − deduction` — what the portal owes before payment |
| `declared_net_payable` | `sor_invoice.net_payable` — the net the portal itself declared |
| `variance` | `declared_net_payable − expected_net_payable`. **Payments are excluded**, so a fully paid invoice whose components agree with the portal has 0 variance. NULL when the portal declares no net. |
| `ledger_status` | `open` (outstanding ≥ ₹1), `overpaid` (≤ −₹1), else `settled` |
| `age_days` | `CURRENT_DATE − invoice_date` |
| `last_activity_at` | `sor_invoice.uploaded_at` (refreshed on every re-sync) |

The view is replaced on every start (`ensureSorOutstandingView`); new
columns may only be appended.

### Line ownership

`sor_invoice_line.source` names the pipeline that wrote a line. A pipeline
re-sync deletes and re-inserts **only its own lines** on an invoice, so a
payment file uploaded later for the same invoice is never wiped by a
re-upload of the invoice file. A header is deleted only once no line from
any source remains.

### Reliance Retail Ltd (AJIO) — Phase 2 mapping

AJIO invoices are imported through the existing Data Hub `mp_invoices`
pipeline (`POST /api/mp-settlement/invoices/upload?marketplace=ajio`).
After every upload — and after `DELETE /invoices/:id` or a scoped AJIO
clear — `backend/services/sorMirror.js` re-reads the **stored** AJIO rows
of each touched invoice and rebuilds its ledger (`source =
'mp_invoices:ajio'`). The upload response carries `sor: { mirrored,
removed, errors }`; a sync failure never fails the upload.

| Stored `mp_invoices` value (per row) | SOR line |
|---|---|
| `invoice_amount` (forward row) | `sale` |
| \|`invoice_amount`\| when the row is a reverse (negative amount, a Return ID, or `order_type` reverse/return). A reverse row written with a **positive** amount has every money field sign-flipped (fees and declared net become refunds), as the Myntra parser does. | `return` |
| `commission_amount`, `other_deductions`, `tcs_amount`, `tds_amount` (each, when ≠ 0, signed) | `deduction` (`raw_payload.fee_type`) |
| `amount_received` (≠ 0) | `payment` (with `payment_date`, `payment_reference`) |

Header: `gross / fee / tds` are sums of the stored rows and `net_payable`
is Σ AJIO's declared `net_payable`. Lines link to AJIO orders only
(`orders.marketplace = 'ajio'`) by `order_line_id`, then
`order_release_id`. Rows of other marketplaces with the same invoice
number are never read. Manual add / edit of an AJIO row re-syncs too (an
edit refreshes both the old and the new invoice number). The one-time
backfill `2026.10.sor-ajio-mirror-2` covers AJIO invoices stored before
the hook existed; it runs after the API is ready (`server.js`) and shares
the mirror's one-at-a-time queue with live uploads.

> Assumption to confirm with an AJIO sample file: reverse rows are
> identifiable by a negative amount, a Return ID or an order-type column.

## 6b. Upload streams, statement and ledger report

Every portal page has five uploads (operator / admin), each with a
downloadable XLSX template whose second sheet lists the accepted column
names (`backend/services/sorUpload.js`):

| Stream | Required columns | Ledger lines | Idempotency key |
|---|---|---|---|
| Invoice | Invoice No, Invoice Date, Invoice Amount (+ SKU, Quantity, Net Payable, PO / Order No) | header + `sale` per row; the declared net = Σ Net Payable | the invoice's own sale lines are **replaced** on re-upload |
| Payment | Invoice No, Payment Date, Amount Paid (+ Payment Reference / UTR) | `payment` | `pay:<UTR>` per invoice |
| Payment advice | Invoice No, Advice Date, Amount Paid and/or TDS · Commission · Discount · Penalty / Claims · Other Deductions | `payment` + one `deduction` per non-zero column | `pay:<UTR>` · `adv:<UTR>:<column>` |
| Return | Invoice No, Return Date, Return Amount (+ Credit / Debit Note No, SKU, Quantity) | `return` | `ret:<note>:<sku>` |
| Deductions | Invoice No, Deduction Date, Deduction Amount (+ Reference, Deduction Type) | `deduction` | `ded:<reference>:<type>` |

- Parsing is deterministic (header aliases, case / punctuation
  insensitive) — no value is guessed. A row with a bad date / number or a
  missing required value is skipped with its reason; rows whose invoice is
  not in the portal's ledger are skipped too ("upload the invoice file
  first"). The response lists up to 200 skipped rows; the page offers them
  as a CSV.
- `UNIQUE (invoice_id, line_type, source_key)`: re-uploading a file
  updates the same lines (a corrected amount replaces the old one).
  Payments share the `pay:<UTR>` key across the payment file, the payment
  advice **and** the AJIO mirror, so one payment is counted once wherever
  it appears. Rows of one document inside a file are summed. An amount
  re-uploaded as **0** removes the line that key posted earlier (only an
  upload's own line; empty cells are ignored).
- Account: the portal default (`ajio_main` for AJIO — the AJIO importer's
  account — `default` elsewhere) unless the upload names one.
- AJIO invoices keep coming through the AJIO `mp_invoices` importer (the
  SOR page calls it directly); `POST …/reliance-ajio/upload/invoice` is
  refused so sale lines have one source.
- **AJIO component ownership:** the AJIO invoice file can also carry
  payments (Amount Received), returns and fees (commission, TDS, TCS, other
  deductions). Each money component of an invoice belongs to the source that
  recorded it first — the AJIO file or the SOR uploads — and the other one
  skips it ("Already recorded from the AJIO invoice file"), in both
  directions. Discounts, penalties and standalone debit notes never collide.
  An upload never takes over a line owned by the AJIO mirror.
- Dates: the day/month order is decided once per column from all of its
  values (a part above 12 settles it; otherwise DD-MM). A column that proves
  both orders is refused.
- Every upload writes `sor_upload_log` (→ Audit History via the trigger).

**Statement** — `GET /api/sor/:portal/statement?from&to&page&pageSize`:
one entry per document (an invoice's sale lines, one payment, one note,
one deduction) dated by `sor_invoice_line.line_date`, debit = sale, credit
= payment / return / deduction, with the running balance computed over the
whole ledger so a date-filtered page shows the true balance, plus opening /
closing balance and per-type totals, all read from one REPEATABLE READ
snapshot. Undated entries count in the opening balance whenever a date
filter is set. The page shows it under the Ledger's **Statement** toggle.

**Ledger report** — `GET /api/sor/:portal/ledger-report?from&to` (XLSX):
*Summary* (opening, invoiced, payments, returns, deductions, closing,
outstanding, overdue > 60 days), *Ledger* (opening row, dated entries with
running balance, closing row) and *Outstanding by invoice*. Capped at
100,000 entries per report.

Migration `2026.10.sor-streams-1` adds `line_date`, `reference_no`,
`description`, `source_key` and the unique key index, and dates existing
lines from their payload or invoice.

### REST contract (`/api/sor`, analyst+ read-only)

| Endpoint | Notes |
|---|---|
| `GET /:portal/outstanding` | `page`, `pageSize` (≤ 500, default 50), `sort` (`invoice_date` · `invoice_no` · `outstanding` · `age_days` · `variance` · `sale_total`), `dir`, `status` (`open` · `settled` · `overpaid`), `invoice_no` (literal substring), `from` / `to` (YYYY-MM-DD), `portal_account`. Returns `{ rows, total, page, pageSize, kpis }`; `kpis` cover the whole filtered portal (status filter excluded) incl. aging buckets, `varianceInvoices`, `lastUploadAt`. |
| `GET /:portal/invoices` | Paginated header list. |
| `GET /:portal/invoice/:id` | Ledger row from `sor_outstanding` + lines grouped by `line_type`. |
| `GET /:portal/statement` | Dated ledger entries with running balance (§6b). |
| `GET /:portal/ledger-report` | XLSX ledger report (§6b). |
| `GET /:portal/template/:stream` | XLSX upload template. |
| `POST /:portal/upload/:stream` | **operator / admin** — upload one stream (§6b). |

Unknown portals → 404 before any query; invalid filters → 400; server
errors return a generic message (no database text).

### Migrations

| Version | Step |
|---|---|
| `2026.10.sor-invoice-1` | Phase 0 (PR #42, applied in production). |
| `2026.10.sor-invoice-2` | Same Phase 0 steps made transactional; on production it only re-creates the audit trigger. |
| `2026.10.sor-ledger-2` | `line_type` + CHECK, `source` (tags lines left by the earlier mirror revision), FK-column and covering indexes. |
| `2026.10.sor-fk-dedupe-1` | Drops the duplicate named FKs Phase 0 added on top of the inline ones (production had both). |
| `2026.10.sor-ajio-mirror-2` | One-time AJIO backfill after startup; recorded only when every invoice synced. |
| `2026.10.sor-ajio-mirror-3` | Re-runs the backfill after `sor-streams-1` so every mirrored line gets its key and date. |
| `2026.10.sor-streams-1` | Upload-stream columns (`line_date`, `reference_no`, `description`, `source_key`) + `UNIQUE (invoice_id, line_type, source_key)`. |

`-2` names: earlier unmerged revisions (PR #44 / #48) used `sor-ledger-1`
and `sor-ajio-mirror-1` with different contents; a version name is never
reused once its contents change.

Rules: each step runs in one transaction on one client with
`lock_timeout` (5 s; 3 s for the FK step) and records its version only on
success, so a failure is retried instead of being silently skipped — in
the background every minute after startup (`finishSorSchema`), then on the
next start. SOR steps run on both the full and the already-current
startup paths and **must not bump `CURRENT_SCHEMA_VERSION`** — that would
send production through the full DDL pass (dozens of `ALTER TABLE` on
`orders` / `returns`) on the shared PostgreSQL server. Startup migrations
only run with `NODE_ENV=production` or `RUN_SCHEMA_MIGRATIONS=true`, so a
local backend pointed at production cannot apply an unmerged branch's DDL.

---

## 7. Implementation phases

Each Phase has its own TaskFlow task (assigned to Pawan).

| Phase | Sub-tab | Scope | TaskFlow task |
|---|---|---|---|
| **Phase 0 — Scaffold** *(merged)* | All 4 | Workspace + routes + DB migration + page stubs | `c5be7da4-0f4f-4127-af8e-8b15f5499050` |
| **Phase 0.5 — Accounting ledger extension** *(PR #44, in review; commit `6d1092d`)* | All 4 | Add `sor_invoice_line.line_type` (sale/payment/return/deduction) + `sor_outstanding` view + outstanding endpoint + KPI grid refactor | `c5be7da4-…` (parent) → `9393b4d6-…` (this PR) |
| **Phase 1** | Myntra Jabong India Pvt Ltd | Excel parsers × 4 (invoice, payment, return, deduction) + upload cards + outstanding ledger + drilldown | `060d4c84-8a8b-4602-8fc9-b5e918812ab6` |
| **Phase 2** | Reliance Retail Ltd (AJIO) | **In review.** AJIO uploads / deletes re-sync the ledger from the stored `mp_invoices` rows (all four streams from the one invoice file — see §6a), with a one-time backfill (`2026.10.sor-ajio-mirror-2`). Data Hub gains an AJIO source button and `/upload?marketplace=ajio` deep link. | `1e7418dc-…` (plan) + `3d8a33dd-…` (impl) |
| **Phase 3** | Zepto Limited | Excel parsers × 4 + upload cards + outstanding ledger + drilldown | `da3de148-8e7a-4bdc-a1f4-b8d6c1c8db1d` |
| **Phase 4** | Cocoblu Retails | Excel parsers × 4 + upload cards + outstanding ledger + drilldown | `ec570612-a290-4ea5-8fc4-bdad27692043` |
| **Phase 5** | Cross-portal | Insights ("Invoices with outstanding > ₹X", "Aging buckets", "Outstanding payments not yet uploaded", etc.) | TBD |

Each per-portal Phase ships **4 upload streams** (invoice / payment /
return / deduction) and the Outstanding Ledger UI for that portal —
never just the invoice stream alone.

---

## 8. Open questions for Pawan (one by one as promised)

> Fill these in as we go. Each question unlocks one Phase.

1. **Myntra** — Do we have the **invoice file format** (column layout,
   invoice-number pattern, period_from / period_to) we already pull
   into `myntraUpload.js`? If yes, we wire that. If different, share
   a sample so we can write the parser.
2. **Zepto** — Data source? (Excel upload, email PDF, manual entry,
   SFTP?) Account identifier(s)? Invoice number pattern? Period
   covered?
3. **AJIO** — Separate file source vs Myntra's? Account identifier(s)?
   Already have an invoice file coming in, or need to start fresh?
4. **Cocoblu** — Same questions as AJIO.
6. **Reconciliation edge** — For each portal, is the "expected
   `net_payable`" calculated as gross − returns − fees − TDS, or does
   the portal apply reverse-charge / GST differently?

---

## 9. Skills used to build this

| Phase | Primary skills |
|---|---|
| 0 — Scaffold | Software Architect (workspace shape), Frontend Developer (route stubs), DB Reliability Engineer (idempotent migration) |
| 1+ per portal | AI Engineer (invoice parser), Data Engineer (ingestion), Backend Architect (service layer), Email Intelligence Engineer (if email source), UI Designer + UX Researcher (per-tab UI), Analytics Reporter (KPI cards) |
| Cross-cutting | AppSec Engineer (every PR), Senior Developer (multi-file merges), Code Reviewer (every PR), DevOps Automator (CI) |

---

## 10. Acceptance criteria

- [x] Workspace `SOR Level Payment Reco` is reachable from the
      Sidebar (analyst+).
- [x] Each portal sub-tab has its own URL and renders without crashing
      even when empty.
- [x] **Phase 0.5** — `sor_invoice_line.line_type` column + CHECK
      constraint; `sor_outstanding` view returns one row per invoice
      with `outstanding = sale − payment − return − deduction`; KPI
      grid on every sub-tab reads from `sor_outstanding` (in review).
- [ ] **Phase 1 (Myntra Jabong)** — 4 upload streams (invoice /
      payment / return / deduction) + Outstanding Ledger + drilldown
      drawer showing all 4 streams per invoice.
- [ ] **Phase 2 (AJIO)** — same shape; existing AJIO upload path wired
      for all 4 streams.
- [ ] **Phase 3 / 4 (Zepto / Cocoblu)** — same shape once data
      sources are confirmed.
- [ ] **Phase 5 (cross-portal)** — Insights cards: total outstanding
      per portal, aging buckets, invoices with outstanding > ₹X but
      no recent payment upload.
- [ ] No regression in existing reconciliation pages.
- [ ] All new endpoints pass `auditLogSanitization`, `uploadSecurity`,
      `dbBatch` tests.
- [ ] Threat model signed off by AppSec before any portal goes live.