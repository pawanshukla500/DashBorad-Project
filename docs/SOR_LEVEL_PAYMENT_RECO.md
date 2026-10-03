# SOR Level Payment Reconciliation — Design Doc

**Status:** Draft, scope to be filled per portal by Pawan
**Owner:** Pawan Shukla
**Last updated:** 2026-10-03

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

The migration `2026.10.sor-invoice-1` is wired into `backend/db/initDb.js`
via `ensureSorInvoiceSchema()`. The DDL shipped in Phase 0 PR #42 is the
single source of truth — reproduced below for reference.

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
CREATE TABLE IF NOT EXISTS sor_invoice_line (
  id              BIGSERIAL PRIMARY KEY,
  invoice_id      BIGINT NOT NULL REFERENCES sor_invoice(id) ON DELETE CASCADE,
  order_id        TEXT,
  sku             TEXT,
  vb_export_sku   TEXT,
  quantity        INT,
  gross_amount    NUMERIC(14,2),
  fee_amount      NUMERIC(14,2),
  settlement_id   BIGINT REFERENCES settlements(id) ON DELETE SET NULL,
  order_row_id    BIGINT REFERENCES orders(id)      ON DELETE SET NULL,
  raw_payload     JSONB NOT NULL
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

---

## 7. Implementation phases

Each Phase has its own TaskFlow task (assigned to Pawan).

| Phase | Sub-tab | Scope | TaskFlow task |
|---|---|---|---|
| **Phase 0 — Scaffold** *(done)* | All 4 | Workspace + routes + DB migration + page stubs | `c5be7da4-0f4f-4127-af8e-8b15f5499050` |
| **Phase 1** | Myntra Jabong India Pvt Ltd | Excel parser + Data Hub upload card + KPI / table / drilldown | `060d4c84-8a8b-4602-8fc9-b5e918812ab6` |
| **Phase 2** | Reliance Retail Ltd (AJIO) | Wire existing AJIO upload path → `sor_invoice` | `1e7418dc-e901-45c4-a042-161779961148` |
| **Phase 3** | Zepto Limited | Excel parser + Data Hub upload card + KPI / table / drilldown | `da3de148-8e7a-4bdc-a1f4-b8d6c1c8db1d` |
| **Phase 4** | Cocoblu Retails | Excel parser + Data Hub upload card + KPI / table / drilldown | `ec570612-a290-4ea5-8fc4-bdad27692043` |
| **Phase 5** | Cross-portal | Insights ("Invoices with variance > ₹X", "Invoices not present in settlement", etc.) | TBD |

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

- [ ] Workspace `SOR Level Payment Reco` is reachable from the
      Sidebar (analyst+).
- [ ] Each portal sub-tab has its own URL and renders without crashing
      even when empty.
- [ ] Myntra sub-tab reconciles invoice-level variances (Phase 1).
- [ ] AJIO sub-tab reconciles invoice-level variances (Phase 2).
- [ ] Zepto + Cocoblu sub-tabs work end-to-end once data sources are
      provided (Phase 3 / 4).
- [ ] No regression in existing reconciliation pages.
- [ ] All new endpoints pass `auditLogSanitization`, `uploadSecurity`,
      `dbBatch` tests.
- [ ] Threat model signed off by AppSec before any portal goes live.