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
    index.js            database connection, pooling, health monitor, retry policy
    initDb.js           schema initialization/migrations (transactional, lock-bounded)
  tests/                regression tests for services, roles, security, and utilities
```

Routes should stay thin: validate the request, call a service, and shape the HTTP
response. SQL that defines a report belongs in a service so the same financial
meaning is not reimplemented by multiple endpoints.

All API route mounting and write permissions live in `backend/routes/index.js`.
New mutation endpoints must be placed below an appropriate access guard.

## Database Resilience & Connection Layer

1. **Multi-Path Cascade `.env` Resolution**:
   - Both `backend/db/index.js` and `backend/server.js` load configuration from a priority cascade: `../.env`, `../../.env`, `process.cwd()/.env`, and `process.cwd()/backend/.env`.
   - Prevents database disconnects when commands, workers, or scrapers are launched from different directory roots.

2. **Connection Pooling & Session Limits**:
   - Configured via `pg.Pool` with `keepAlive: true`, `keepAliveInitialDelayMillis: 10_000`, `idleTimeoutMillis`, and bounded `statement_timeout` (`PG_READ_STATEMENT_TIMEOUT_MS`, default 45s).
   - Long-running transactional batch operations (such as catalog synchronization and SOR backfills) acquire dedicated clients and explicitly clear session statement timeouts.

3. **Query Safety & CTE Recognition**:
   - Read queries pass through `isSafeReadStatement` before retry attempts.
   - Recognized safe statements include `select`, `show`, `explain`, `values`, and Common Table Expressions (`WITH ... SELECT`) that do not contain write clauses (`insert into`, `update`, `delete from`).
   - Ensures transient network drops during complex multi-CTE reporting queries retry safely without false-positive database offline flags.

4. **Automatic Reconnection & Healing**:
   - `getPool().connect()` incorporates a 2-attempt backoff retry loop.
   - `startDatabaseHealthMonitor()` polls connectivity periodically; on socket resets or network drops, `recoverDatabaseConnection()` rebuilds the internal pool transparently in the background without dropping incoming HTTP requests.

## Frontend Design System & Brand Token Architecture

```text
frontend/src/
  pages/                screen composition and page-level state
  components/           reusable UI, including the shared KPI card and drawers
  components/charts/    reusable report charts
  api/client.js         backend transport facade
  utils/format.js       shared report and currency formatting
  context/              authentication and cross-page filters
```

1. **Brand Burgundy Design Tokens**:
   - The palette is rooted on brand burgundy `#902A4A` and defined in `frontend/tailwind.config.js`.
   - **Token Pairs**: Light surfaces (`bg-primary-container`, `#fbe9f0`) must strictly take `text-on-primary-container`, never white (`text-on-primary`). Dark surfaces (`bg-primary`, `hover:bg-indigo-dark`) take `text-on-primary`.
   - **Zero Residual Indigo Rule**: Raw Tailwind `indigo-*` and ad-hoc pink utilities are prohibited across all pages, charts, tables, and modal drawers. All active states, badges, and highlights use brand tokens (`bg-primary`, `bg-primary-container`, `text-primary`, `border-primary/20`).

2. **Bundle Optimization**:
   - Rollup `manualChunks` configured in `frontend/vite.config.js`:
     - `react-vendor` (React, React-DOM, React Router)
     - `firebase-vendor` (Firebase App & Auth)
     - `charts-vendor` (Recharts & D3 dependencies)
     - `xlsx-vendor` (SheetJS)
   - Keeps entry bundle `index.js` lean (~124 kB) with rapid (~5s) production builds.

## API Security & Protection Architecture

1. **Authentication Boundary**:
   - All `/api/*` endpoints (except public `/health` and `/api/health`) require a valid Firebase ID token via `authMiddleware`.
   - Requests without a valid Bearer token are rejected with `401 Unauthorized`.

2. **Revocation State Management**:
   - Token revocation is cached in-memory with automatic pruning (`pruneRevocationCache`) to avoid recurring Firebase round-trips while honoring user deletions and role alterations within 60 seconds.

3. **Role Gating & Mutation Guards**:
   - `requireRole(allowedRoles)` enforces RBAC across routes.
   - `mutationAccessGuard` gates `POST`/`PUT`/`PATCH` to `operator` and `admin`, and `DELETE` strictly to `admin`.
   - `rateCardAccessGuard` restricts rate card configuration and rule modifications to `admin`.

4. **Public vs. Loopback Health Projections**:
   - `healthCheckHandler` inspects caller remote address. Loopback callers (Docker healthcheck, container exec) receive full diagnostic details (`databaseDetail`).
   - External callers receive the sanitized `publicDatabaseStatus` projection, strictly omitting internal connection strings, pool statistics, and error diagnostics (`transport`, `pool`, `lastError`, `internalError`).

5. **Input Validation & Error Sanitization**:
   - Malformed JSON payloads return `400 Bad Request` via Express error middleware and `publicApiError`, preventing raw stack trace disclosure.

## Marketplace Accounts & Desktop Scraper

1. **Credential Security at Rest**:
   - Marketplace account passwords in `backend/routes/marketplaceAccounts.js` are encrypted using AES-256-GCM authenticated encryption (`backend/utils/credentialCrypto.js`). Master key derivation dynamically resolves environment secrets (`CREDENTIALS_ENCRYPTION_KEY`, `ENCRYPTION_KEY`, or `JWT_SECRET`). In production (`NODE_ENV=production`), missing secrets strictly trigger a fatal configuration error. Keyring rotation (`PREVIOUS_ENCRYPTION_KEYS`), startup migration (`reencryptMarketplaceCredentials`), and opportunistic re-encryption on reveal guarantee zero-downtime rotation and eliminate indefinite reliance on legacy keys.
   - Logos are sourced directly from Brandfetch SVG endpoints for Amazon, Cocoblu, Myntra, Flipkart, Reliance Retail / AJIO, Meesho, and Shopify.
   - Myntra accounts strictly isolate `myntra_vb` (Seller ID 10708) and `myntra_ej` (Seller ID 45833).

2. **Standalone Desktop Application**:
   - Windows installer distributed in `released/ReconCentral-RateCard-Worker-Setup.exe` (and standalone portable build `released/ReconCentral-RateCard-Worker-Portable.exe`), documented in `released/INSTALLATION_AND_AUTHORIZATION_GUIDE.md`.
   - Direct Puppeteer automation for rate card extraction and order sync without requiring browser extensions or terminal commands.
   - Authenticates against Firebase Auth and PostgreSQL role claims with zero hardcoded administrative credentials in the binary.

## Duplication Rules & Subsystem Boundaries

- One URL has one route implementation. Amazon settlement ingestion is canonical in `backend/routes/amazonUpload.js`; its report definitions live in `backend/services/amazonSettlementReports.js`.
- One report meaning has one service query. Return/SPF status is defined in `backend/services/returnReports.js`.
- File import coercion uses `backend/utils/valueParsers.js`; numeric zero must not be converted to null.
- Pagination uses `backend/utils/requestParams.js` and always has positive bounds.
- UI currency, percentages, dates, and KPI cards come from shared frontend code (`frontend/src/utils/format.js` and `components/KPICard.jsx`).
- Temporary dumps (`*.tmp`, `Tempcf*`) are ignored and must not become runtime data sources.

Amazon's current natural-key model, idempotent upload behavior, and query performance rules are documented in [`docs/AMAZON_ARCHITECTURE.md`](AMAZON_ARCHITECTURE.md).

Myntra's separate EJ/VB account model, seller-ID boundary, source-layout mapping, and data model are documented in [`docs/MYNTRA_HANDOFF.md`](MYNTRA_HANDOFF.md).

The Data Center's allowed marketplace/upload combinations and upload-history remark contract are documented in [`docs/DATA_CENTER_UPLOADS.md`](DATA_CENTER_UPLOADS.md). Keep its single allow-list in `UploadPage.jsx`; do not restore individual visibility flags that can leak another marketplace's file type into the current selection.

The **SOR Level Payment Reco** workspace (invoice-grain reconciliation across Myntra Jabong India Pvt Ltd, Zepto Limited, Reliance Retail Ltd (AJIO), Cocoblu Retails) is documented in [`docs/SOR_LEVEL_PAYMENT_RECO.md`](SOR_LEVEL_PAYMENT_RECO.md). Workspace is `EXPORT_ROLES` (analyst+) only — enforced both in `frontend/src/navigation.js` and per-route in `frontend/src/App.jsx`. Audit integration piggybacks on the existing `upload_log` via the `trg_sor_upload_log_mirror` trigger so Audit History surfaces SOR uploads without a code change.

## Verification

From `backend/`, run `npm test` (84 files, 509 tests). From root, run `node desktop/tests/test_desktop_auth.js` (6 tests). From `frontend/`, run `npm run build`. Add a regression test whenever a report definition, permission, or upload parser is changed.
