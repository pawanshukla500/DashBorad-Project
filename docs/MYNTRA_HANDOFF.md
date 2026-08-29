# Myntra EJ/VB upload handoff

This document is the current source of truth for a coding agent continuing the
Myntra work. It describes what is implemented, what has been verified, and the
boundaries that must not be weakened.

## Current outcome

Data Center has two separate Myntra selections, each with the same three data
types:

| Data Center selection | Seller account | Required seller ID in column A |
|---|---|---:|
| Myntra (EJ) | `myntra_ej` | `45833` |
| Myntra (VB) | `myntra_vb` | `10708` |

Available uploads in each selection are **Sales / Orders**, **Returns**, and
**Invoice / Payment**. The two accounts share parser logic but never share an
import boundary, data count, upload-history entry, or clear action.

## Safety rules — do not remove

1. A user must select `Myntra (EJ)` or `Myntra (VB)` before Order/Return upload.
2. The importer reads the seller ID from every source row before it writes any
   data. A file is rejected as a whole when even one row has the wrong or blank
   seller ID. No partial import is allowed.
3. The user-facing error says which account was selected, which seller ID it
   accepts, and identifies the other account when the supplied ID is known.
4. PostgreSQL repeats the same protection with check constraints on
   `myntra_order_details` and `myntra_return_details`. Application code alone
   is not the only protection.
5. Keep all account-sensitive SQL scoped by both `marketplace = 'myntra'` and
   `seller_account`. Clearing EJ must never delete VB rows and vice versa.
6. Do not route these layouts through the generic `/api/upload/orders` or
   `/api/upload/returns` mapper. Their keys and meaning are Myntra-specific.

## Files and endpoints

| Purpose | Location |
|---|---|
| Dedicated parser, validation, templates | `backend/routes/myntraUpload.js` |
| Route mount | `backend/routes/index.js` at `/api/upload/myntra` |
| Frontend Data Center UI | `frontend/src/pages/UploadPage.jsx` |
| API client calls | `frontend/src/api/client.js` |
| Schema migrations | `backend/db/initDb.js` |
| Data counts and account-scoped clear | `backend/routes/upload.js` |
| Regression tests | `backend/tests/myntraDataCenter.test.js`, `backend/tests/myntraLayoutMapping.test.js` |

Endpoints:

```text
POST /api/upload/myntra/orders?seller_account=myntra_ej|myntra_vb
POST /api/upload/myntra/returns?seller_account=myntra_ej|myntra_vb
GET  /api/upload/myntra/template/orders
GET  /api/upload/myntra/template/returns
POST /api/mp-settlement/invoices/upload?marketplace=myntra&seller_account=myntra_ej|myntra_vb
```

All are behind the existing Firebase-authenticated upload mutation guard.

## Source-layout mapping

### Order Layout

Reference source: `Myntra Order Layout.xlsx`.

| Excel column | Stored meaning |
|---|---|
| `seller id` | Account guard and raw audit data |
| `order release id` | Canonical Order ID |
| `order line id` | Canonical Order Item ID / import natural key |
| `po_type` | `PPMP` = `Non-FBM`; every other value = `FBM` |
| `created on` | SQL `order_date` |
| `seller sku code` | Seller SKU |
| `myntra sku code` | Myntra FSN-like identifier |
| `brand` | Brand and `brand_name` |
| `article type` | Category |
| `final amount` | Customer sale amount |
| `seller price` | Seller-price fields used for later rate-card analysis |
| `city`, `state`, `zipcode` | Delivery location |
| lifecycle dates and tracking fields | Structured Myntra detail data and raw source JSON |

`order status` is preserved in the detail table. Canonical reporting lifecycle
uses this priority: cancelled → RTO (including blank tracking number) → return
initiated → delivered → raw order status.

### Return Layout

Reference source: `Myntra Return Layout.xlsx`.

| Excel column | Stored meaning |
|---|---|
| `seller_id` | Account guard and raw audit data |
| `order_id` | Links to Order `order release id` |
| `order_line_id` | Links to Order `order line id`; canonical return key |
| `model` | `PPMP` = `Non-FBM`, otherwise `FBM` |
| `type` | Return/RTO type |
| `status`, `return_status` | Return state and result |
| `return_created_date`, `refunded_date`, `order_rto_date` | SQL-compatible lifecycle dates |
| `seller_sku_code`, `myntra_sku_code`, `brand`, tracking fields | Structured detail data and raw source JSON |

## Database model

The importer writes both layers below. Do not remove the raw/detail layer just
because common dashboards currently read the canonical layer.

1. `orders` and `returns`: normalized shared-report rows, scoped by
   `(marketplace, seller_account, order_item_id)`.
2. `myntra_order_details`: structured Myntra-specific fields plus `source_data`
   JSONB containing the full source row.
3. `myntra_return_details`: equivalent Return fields and source JSONB.
4. `mp_invoices`: account-scoped Invoice/Payment data.
5. `upload_log` types: `myntra_ej_orders`, `myntra_ej_returns`,
   `myntra_ej_invoices`, and equivalent `myntra_vb_*` types.

Schema migration markers already applied in PostgreSQL:

```text
2026.08.myntra-ej-vb-order-return-1
2026.08.myntra-seller-id-guard-1
```

## Corrected historical mistake

VB Order and Return files were once imported under EJ. The incorrect data was
removed on 2026-08-18:

- 14,329 EJ order rows removed;
- 5,840 EJ return rows removed;
- matching raw-detail rows and the two erroneous upload-log entries removed;
- no EJ invoice/payment rows were removed.

The supplied files with seller ID `10708` were then tested: both are rejected
under EJ and accepted under VB. They are ready to be uploaded from the **Myntra
(VB)** Data Center selection if the business user chooses to do so.

## Verification before changing this area

```powershell
cd backend
node .\node_modules\vitest\vitest.mjs run tests\myntraDataCenter.test.js tests\myntraLayoutMapping.test.js --pool=forks --maxWorkers=1 --no-file-parallelism

cd ..\frontend
node .\node_modules\vite\bin\vite.js build
```

Also use the application health endpoint. Do not expose the database URL or
other credentials in output, code, documentation, or a frontend build.

## Next work for a coding agent

1. Import real files under their correct account selection only after the user
   requests it.
2. Build Myntra payment reconciliation against account-scoped rate cards; do
   not reuse Amazon or Flipkart fee assumptions.
3. Add rate-card configuration and fee-leak reporting for each Myntra account.
4. Whenever adding an account or changing seller IDs, update all three layers:
   `marketplace_accounts`, importer validation, and SQL constraints/migration.
