# ReconCentral architecture

The application follows a simple request flow:

```text
React page -> frontend API client -> Express route -> service -> PostgreSQL
```

## Backend boundaries

*Note: The Marketplace Rate Card system and fee calculations are handled by a **separate Python service** connecting directly to the PostgreSQL database, independent of this Express.js backend.*

```text
backend/
  routes/
    index.js            API namespaces and access policy
    *.js                HTTP input/output and upload parsing
  services/
    amazonSettlementIngest.js transactional, idempotent settlement writes
    amazonSettlementReports.js Amazon fee vocabulary and report queries
    returnReports.js    return/SPF report queries and business meaning
    userSync.js         Firebase-to-Postgres identity synchronization
    *.js                reusable business and database operations
  utils/
    requestParams.js    safe pagination and request coercion
    valueParsers.js     shared spreadsheet value parsing
    *.js                stateless helpers
  db/
    index.js            database connection
    initDb.js           schema initialization/migrations
  tests/                regression tests for services, roles, and utilities
```

Routes should stay thin: validate the request, call a service, and shape the HTTP
response. SQL that defines a report belongs in a service so the same financial
meaning is not reimplemented by multiple endpoints.

All API route mounting and write permissions live in `backend/routes/index.js`.
New mutation endpoints must be placed below an appropriate access guard.

## Frontend boundaries

```text
frontend/src/
  pages/                screen composition and page-level state
  components/           reusable UI, including the shared KPI card
  components/charts/    reusable report charts
  api/client.js         backend transport facade
  utils/format.js       shared report and currency formatting
  context/              authentication and cross-page filters
```

Pages should use shared formatters and components instead of defining local
copies. API response names should reflect one business glossary: gross revenue,
bank received, marketplace fees, refunds, COGS, and net profit.

## Duplication rules

- One URL has one route implementation. Amazon settlement ingestion is
  canonical in `backend/routes/amazonUpload.js`; its report definitions live in
  `backend/services/amazonSettlementReports.js`.
- One report meaning has one service query. Return/SPF status is defined in
  `backend/services/returnReports.js`.
- File import coercion uses `backend/utils/valueParsers.js`; numeric zero must not
  be converted to null.
- Pagination uses `backend/utils/requestParams.js` and always has positive bounds.
- UI currency, percentages, dates, and KPI cards come from shared frontend code.
- Temporary dumps (`*.tmp`, `Tempcf*`) are ignored and must not become runtime
  data sources.

Amazon's current natural-key model, idempotent upload behavior, and query
performance rules are documented in `docs/AMAZON_ARCHITECTURE.md`.

Myntra's separate EJ/VB account model, seller-ID boundary, source-layout
mapping, and data model are documented in `docs/MYNTRA_HANDOFF.md`.

The Data Center's allowed marketplace/upload combinations and upload-history
remark contract are documented in `docs/DATA_CENTER_UPLOADS.md`. Keep its
single allow-list in `UploadPage.jsx`; do not restore individual visibility
flags that can leak another marketplace's file type into the current selection.

## Verification

From `backend/`, run `npm test`. From `frontend/`, run `npm run build`. Add a
regression test whenever a report definition, permission, or upload parser is
changed.
