# ReconCentral RateCard Worker Rebuild Report

**Target Repository:** `pawanshukla500/DashBorad-Project`  
**Base & Target Branch:** `master` (Commit `6a2b5e5` via PR #73)  
**Date:** October 30, 2026  
**Status:** Merged, Verified & Production Packaged  

---

## 1. Executive Summary & Primary Objectives

The ReconCentral Rate Card Worker integration has been completely rebuilt from a desktop direct-PostgreSQL architecture into a centralized, API-orchestrated, production-grade automation system:

1. **Zero Desktop Database Credentials**: The desktop application no longer accepts or requires `DESKTOP_DATABASE_URL`, `DATABASE_URL`, or any PostgreSQL passwords. All database queries and mutations are managed by the canonical backend API over TLS.
2. **Centralized Job System**: Desktop workers authenticate via Firebase bearer tokens, register in PostgreSQL `workers`, send heartbeats every 25s, and atomically claim jobs using `FOR UPDATE SKIP LOCKED`.
3. **Crash-Resilient SQLite Staging (`staging.db`)**: Built via WebAssembly `sql.js` in `desktop/localStaging.js`. Avoids native C++ dependencies while ensuring extractions survive process kills and network interruptions.
4. **Canonical Flipkart Change Detection & Zero-Change Protection**: `backend/services/rateCardCanonicalEngine.js` performs decimal-safe normalization across commissions, fixed fees, collection fees, and reverse shipping. If extracted rates match existing active rules in PostgreSQL, **zero rows are modified, deleted, auto-closed, or republished**.
5. **Safe Transactional Publishing**: `backend/services/rateCardPublisher.js` executes inside PostgreSQL advisory transaction lock `pg_advisory_xact_lock(hashtext('rate_card_publish_lock'))`. Pre-existing active rules are cleanly closed (`end_date = dayBefore(effectiveDate)`) bounded by `start_date <= previousEndDate`, brand overrides are isolated, and immutable snapshots are archived in `rate_card_versions`.
6. **Marketplace Interaction Pacing**: Scraping routines enforce at least a 1000ms pause between successive automated page interactions.

---

## 2. Live Schema Inspection Report

The PostgreSQL rate card subsystem drives all financial fee calculations and monthly reconciliations. Inspection revealed:

| Table | Primary Columns & Types | Active Rule Strategy | Nullable Boundaries |
| :--- | :--- | :--- | :--- |
| `rc_commission` | `category` (text), `brand_name` (text, nullable), `start_date` (date), `end_date` (date), `price_min`/`price_max` (numeric), `rate` (numeric) | `end_date IS NULL` | `brand_name` is NULL for generic category rules; `start_date` can be NULL for legacy seed rules. |
| `rc_fixed_fee` | `category` (text), `fulfilment_type` (text, nullable), `start_date`/`end_date` (date), `price_min`/`price_max` (numeric), `rate` (numeric) | `end_date IS NULL` | `fulfilment_type` defaults to `'All'` or tier name (e.g. `'Bronze'`). |
| `rc_collection_fee` | `category` (text), `start_date`/`end_date` (date), `prepaid`/`postpaid` (numeric), `prepaid_type`/`postpaid_type` (`pct` or `flat`) | `end_date IS NULL` | `prepaid_type` and `postpaid_type` record fee structure. |
| `rc_reverse_shipping` | `category` (text), `weight_slab` (text), `start_date`/`end_date` (date), `local_fee`, `zonal_fee`, `national_fee` (numeric) | `end_date IS NULL` | Slabs structured as `0-0.5kg`, `0.5-1kg`, etc. |
| `rate_card_versions` | `marketplace`, `seller_account`, `version_name`, `status`, `effective_from`, `snapshot` (jsonb), `created_at`, `published_at` | Version History | Author email, audit notes, and slab arrays are serialized in `snapshot` JSONB. |
| `workers` | `id` (text PK), `hostname`, `platform`, `app_version`, `status`, `last_heartbeat` | Active Worker Registry | Background worker heartbeats keep status `online`. |
| `worker_jobs` | `id` (serial PK), `idempotency_key` (unique), `marketplace`, `seller_account`, `job_type`, `status`, `lease_worker_id`, `lease_expires_at`, `results` (jsonb), `diff_summary` (jsonb) | Persistent Job Queue | State machine: `queued` → `claimed` → `running` → `completed` / `failed` / `cancelled`. |

---

## 3. Root Cause of Desktop Offline & "Not Configured" Status

In prior releases (v1.6.0/v1.7.0):
1. **Direct DB URL Requirement**: The desktop UI checked `getSavedDatabaseUrl()`. If no PostgreSQL URL was saved in client settings, the header rendered `Database Connection: Not Configured` and `Brands Configured: Not Configured`.
2. **Missing Backend Job Pipeline**: The web dashboard lacked an API-mediated worker bridge, attempting either direct in-backend Puppeteer runs or expecting the desktop app to manipulate PostgreSQL directly.
3. **Resolution**: Removed raw database connection displays from the desktop header. Replaced with live backend API connectivity:
   - Status badge: `ReconCentral Cloud API: Connected`
   - Data badge: `Synced via Backend API`
   - Active worker heartbeat engine automatically establishes connection upon authenticated session.

---

## 4. Source Changes Summary

- **Database Migrations (`backend/db/initDb.js`)**:
  - `2026.10.ratecard-worker-jobs-1`: Created tables `workers` and `worker_jobs`, with claim/lease indexes and period uniqueness constraints.
  - `2026.10.ratecard-worker-jobs-2`: Cleaned up pre-existing duplicates and created partial unique indexes `rc_*_uniq_active ... WHERE end_date IS NULL`.
- **Backend Job Endpoints (`backend/routes/workerJobs.js`)**:
  - `POST /api/workers/register`: Registers worker ID, hostname, platform, and version.
  - `POST /api/workers/heartbeat`: Renews heartbeat timestamp.
  - `GET /api/workers`: Lists connected workers and online status.
  - `POST /api/workers/jobs/claim`: Atomically claims `RATE_CARD_SCRAPE` jobs using `SKIP LOCKED`.
  - `POST /api/worker-jobs/:id/progress`: Updates job progress; responds 409 `JOB_NOT_RUNNING` if cancelled.
  - `POST /api/worker-jobs/:id/results`: Accepts scrape observations, verifies lease, runs canonical comparison, and saves diff summary.
  - `POST /api/worker-jobs/:id/publish`: Role-gated to `admin`; acquires advisory transaction lock and publishes verified changes.
  - `POST /api/worker-jobs/:id/cancel`: Cancels queued or running jobs.
- **Canonical Comparison Engine (`backend/services/rateCardCanonicalEngine.js`)**:
  - Compares commissions, fixed fees, collection fees, and reverse shipping with 4-decimal rate precision and 2-decimal currency precision.
  - Detects added, modified, and removed slabs.
  - Protects brand-specific commission rates from generic category scrapes.
  - Filters active DB records using `(start_date IS NULL OR start_date <= effectiveDate) AND (end_date IS NULL OR end_date >= effectiveDate)`.
- **Safe Publisher (`backend/services/rateCardPublisher.js`)**:
  - Re-checks diff under transaction lock. If zero changes, returns immediately with 0 rows modified.
  - Auto-closes prior active rules bounded by `start_date <= previousEndDate`.
  - Scopes commission auto-closing so generic scrapes only close generic rules.
  - Serializes author email and metadata into `snapshot` JSONB.
- **Desktop SQLite Staging (`desktop/localStaging.js`)**:
  - WebAssembly `sql.js` staging database in Electron `userData/staging.db`.
  - Persists jobs and observation checkpoints; clears staged data only after server receipt acknowledgement.
- **Desktop Runtime & Client (`desktop/workerClient.js`, `desktop/main.js`, `desktop/ui/renderer.js`)**:
  - Enforces strict HTTPS allowlist; strips authorization headers on foreign domains.
  - Worker engine background poller claims and processes jobs.
  - UI displays live Cloud API connectivity and staged diff inspection.
- **Web Dashboard (`frontend/src/pages/RateCardConfigPage.jsx`)**:
  - Integrated worker status card, job progress tracking, cancellation, and 1-click diff review/publish.

---

## 5. Verification & Testing Evidence

- **Backend Unit & Integration Suite**:
  - `86 test files passed, 598 tests passed` (`npm --prefix backend test`).
  - Added dedicated tests in `backend/tests/workerJobsAndCanonical.test.js` verifying:
    - Zero rate changes producing 0 modifications.
    - Anomaly detection on $\ge 50\%$ shifts.
    - Added slabs detection.
    - Removed slabs detection.
    - Brand-specific commission isolation against generic scrapes.
    - Matching active rows with `start_date IS NULL`.
- **Desktop Runtime & E2E Suite**:
  - `83 tests passed` (`npm --prefix desktop test`):
    - 4 staging tests (`test_local_staging.js`)
    - 70 runtime regression tests (`test_desktop_runtime.js`)
    - 9 E2E pipeline tests (`test_desktop_e2e.js`)
- **Frontend Production Build**:
  - Vite build passed in 5.13s (`npm --prefix frontend run build`).
- **GitHub Actions CI**:
  - Workflow run `41042786371` (`Run tests & build`) completed green in 49s.
- **CodeAnt AI Review**:
  - Review status confirmed complete (`done: true`) on PR #73.
  - All feedback (atomic lease checks, admin role gates, start_date nullability, brand isolation) addressed.

---

## 6. Release Binaries

Built via `electron-builder --win --x64` and verified in `released/`:
- `released/ReconCentral-RateCard-Worker-Setup.exe` (98,534,465 bytes)
- `released/ReconCentral-RateCard-Worker-Portable.exe` (98,315,537 bytes)
- `released/INSTALLATION_AND_AUTHORIZATION_GUIDE.md`

---

## 7. Rollback Plan

If a rollback is ever required:
1. **Rate Card Data**: Every published change writes an immutable snapshot to `rate_card_versions`. Prior rules retain their original `start_date` and `end_date = dayBefore(effectiveDate)`. Reverting involves updating `end_date = NULL` on the prior version's rows and setting `end_date = NOW()` on the newly published rows.
2. **Database Migrations**: Tables `workers` and `worker_jobs` are purely additive. If needed, they can be dropped without affecting existing `rc_*` or order/settlement reconciliation tables:
   ```sql
   DROP TABLE IF EXISTS worker_jobs CASCADE;
   DROP TABLE IF EXISTS workers CASCADE;
   ```
3. **Application Rollback**: Git commit `dc05675` (PR #72) represents the last stable pre-API-worker state.

---

## 8. Pull Request & Deployment Status

- **PR Link**: [PR #73](https://github.com/pawanshukla500/DashBorad-Project/pull/73)
- **Merge Commit**: [`6a2b5e5`](https://github.com/pawanshukla500/DashBorad-Project/commit/6a2b5e5)
- **Merged To**: `master` (Squash merged with branch cleanup)
- **TaskFlow Pro**: Task `7bda7fc2-b23c-4aa4-a9e5-0fb7d0cb20c3` transitioned to `done`.
