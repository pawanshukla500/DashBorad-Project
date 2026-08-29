# Data Center upload contract

This is the source of truth for the visible upload choices on the **Data &
Setup → Uploads** page. It exists to prevent one marketplace's importer from
being shown under another marketplace.

## Visible upload choices

| UI selection | Dataset key | Visible label | Importer boundary |
|---|---|---|---|
| Flipkart | `orders` | Sales / Orders | Generic Flipkart order importer |
| Flipkart | `returns` | Returns | Generic Flipkart return importer |
| Flipkart | `fk-settlement` | FK Settlement Report | Multi-sheet Flipkart settlement importer |
| Amazon | `amazon-sale-orders` | Sale Orders | Amazon sale-order importer |
| Amazon | `amazon-fba-returns` | FBA Returns | Amazon FBA-return importer |
| Amazon | `amazon-flex-returns` | Flex Returns | Amazon Flex-return importer |
| Amazon | `amazon-settlement` | Settlement (Payment) | Amazon Flat-File V2 settlement importer |
| Myntra (EJ) | `myntra-orders` | Sales / Orders | Myntra Order Layout importer, EJ scope |
| Myntra (EJ) | `myntra-returns` | Returns | Myntra Return Layout importer, EJ scope |
| Myntra (EJ) | `myntra-invoices` | Invoice / Payment | Account-scoped Myntra invoice importer, EJ scope |
| Myntra (VB) | `myntra-orders` | Sales / Orders | Myntra Order Layout importer, VB scope |
| Myntra (VB) | `myntra-returns` | Returns | Myntra Return Layout importer, VB scope |
| Myntra (VB) | `myntra-invoices` | Invoice / Payment | Account-scoped Myntra invoice importer, VB scope |

Myntra has the same three-stage business flow as Flipkart (orders, returns,
payment), but its payment file is **not** a Flipkart Settlement Report and must
remain labelled **Invoice / Payment**.

## Implementation boundary

`frontend/src/pages/UploadPage.jsx` owns the single
`DATA_TYPE_KEYS_BY_MARKETPLACE` allow-list and derives every visible button from
it. The allow-list is:

```text
flipkart → orders, returns, fk-settlement
amazon   → amazon-sale-orders, amazon-fba-returns, amazon-flex-returns, amazon-settlement
myntra   → myntra-orders, myntra-returns, myntra-invoices
```

Do not use independent flags such as `amazonOnly`, `myntraOnly`,
`flipkartOnly`, or `hideOnAmazon`. They previously allowed duplicate Flipkart
and Myntra buttons to appear while Amazon was selected, and vice versa.

When a marketplace tab is selected, choose the first dataset in that
marketplace's allow-list. This prevents an old selection from remaining active
when its button is no longer valid for the new marketplace.

## Myntra account boundary

Myntra is one marketplace with two isolated seller accounts:

| Data Center tab | Account key | Required seller ID in source column A |
|---|---|---:|
| Myntra (EJ) | `myntra_ej` | `45833` |
| Myntra (VB) | `myntra_vb` | `10708` |

The frontend supplies the account; the importer validates every Order/Return
row before writing and PostgreSQL repeats the protection with constraints. See
`docs/MYNTRA_HANDOFF.md` for mapping and migration details.

## Upload remarks

The post-upload result card, the Upload Status Board, and the full Upload
History all save remarks through:

```text
POST /api/upload/log/:id/remark
body: { "remark": "optional text, up to 500 characters" }
```

`backend/routes/upload.js` validates the numeric log ID, updates the matching
`upload_log` row, and returns the updated `id` and `remark`. A missing row is a
404 and an invalid ID is a 400. The UI must not show a success state until the
response has `{ ok: true }`; on a failed request it must retain the entered
text and display the error.

After a successful save, refresh upload status/history so the remark is visible
without a manual page reload.

## Clearing imported data: retain the evidence

The trash action is restricted to administrators. It removes the selected
business data so a corrected file can be imported, but it **must not delete the
upload-history record**.

Before the clear is confirmed, the UI requires a reason. In one transaction the
backend deletes the scoped business rows and marks each affected `upload_log`
record with:

- `data_cleared_at` — when the data was removed;
- `cleared_by` and `cleared_by_email` — the Firebase identity of the
  administrator who removed it;
- `clear_reason` — the supplied explanation;
- `cleared_row_counts` — the number of rows removed from each physical table.

The original filename, upload time, processed/updated/skipped counts, skipped
row details, and upload remark remain unchanged. The **Upload Status Board**
only uses active (not-cleared) records; **All upload history** includes them and
has a **Cleared data** status filter. Search also matches the clear reason and
the clearing user's email.

## Knowing whether data is up to date

The Uploads page distinguishes two dates:

1. **Uploaded at** in **All upload history** is the time the application
   received a specific file. Use it to trace the file, operator remark, and row
   counts.
2. **Current data coverage** is the business-date range presently stored in
   PostgreSQL for the selected marketplace/account. Its **Updated through**
   value is the last business date available in that dataset after all active
   uploads and corrections.

The coverage panel covers Flipkart Orders, Returns, and Settlement; Amazon Sale
Orders, FBA Returns, Flex Returns, and Settlement; and the selected Myntra
EJ/VB account's Orders, Returns, and Invoice/Payment. It deliberately excludes
cleared data. Use **Refresh dates** to fetch the latest values; use **Refresh**
in All upload history to fetch the latest file records.

The importer currently stores the source **filename and parsed/audit metadata**,
not the original workbook binary. Therefore a file cleared before this change
cannot be downloaded or reconstructed from the database; it can only be
identified if its `upload_log` record or general audit event survived. Store
original files in private object storage with a checksum only if later download
or source-file forensic recovery is a business requirement.

## Regression checks

The following test protects the choices and remark contract:

```powershell
cd backend
npx vitest run tests/uploadDatasetChoices.test.js tests/uploadClearAudit.test.js --pool=forks --maxWorkers=1 --no-file-parallelism
```

Also build the UI after any Uploads-page change:

```powershell
cd frontend
npm run build
```
