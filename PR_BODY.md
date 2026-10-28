## Summary of Changes

### 1. Root Cause Resolution for Packaged Electron App Crash (`ERR_MODULE_NOT_FOUND`)
- **Issue**: In the packaged Electron application, `desktop/authValidation.js` attempted to import `../backend/utils/cookieVault.js`. In packaged ASAR archives, relative parent paths (`../`) resolve outside `app.asar` into `resources/`, where `backend/` does not exist on end-user machines, throwing an uncaught exception on startup.
- **Fix**: Created self-contained `desktop/cookieVault.js` directly within `desktop/` and updated `desktop/authValidation.js` to import `./cookieVault.js`. Added safe `.catch(() => null)` fallback for optional backend `firebaseAdmin.js` during cryptographic token validation.

### 2. Removal of Redundant `relased` Directory
- Deleted the obsolete duplicate typo folder `relased/` and removed `relasedTypoDir` from `scripts/prepare-release.js` so it is never recreated.
- Standardized all production installers and documentation strictly within `released/`.

### 3. Self-Contained Desktop Architecture & Extensibility
- **`desktop/db.js`**: Standalone resilient PostgreSQL pool client for the desktop app with safe query execution, connection latency testing, and future-ready `downloadTableDetails` and `uploadTableUpdates` helpers for downloading database details and syncing updates as a desktop extension.
- **`desktop/rateCardService.js`**: Standalone brand rate card calculation, FSN discovery, change detection against PostgreSQL, and database synchronization with automatic period closure (`end_date = dayBefore(new_start_date)`).
- **`desktop/excelExport.js`**: Formatted 6-sheet workbook exporter with graceful structured fallback.
- **`desktop/chromeFinder.js`**: Cross-platform Chrome & Chromium executable resolver for Windows, Linux, and macOS.
- **`desktop/preload.js`**: Exposes `downloadDatabaseDetails` and `uploadDatabaseDetails` APIs to renderer for desktop extension workflows.

### 4. Cross-Platform Linux & Windows Operability
- Verified and enhanced `released/linux/install-linux.sh` to automatically install production dependencies into `/opt/reconcentral-ratecard/`, create `/usr/local/bin/reconcentral-ratecard` symlink, and register a background `systemd` service (`reconcentral-ratecard.service`).
- `start-ratecard-desktop.sh` and `start-ratecard-desktop.bat` allow instant local startup on Linux and Windows.

### 5. Quality & Verification Gates
- **Desktop Auth & Gateway Tests**: `node desktop/tests/test_desktop_auth.js` passes 8/8 tests.
- **CLI Worker**: `node desktop/worker.js --help` executes cleanly without module resolution errors.
- **Full Backend Test Suite**: 84 test files, 515 tests passing 100% green (`npm test`).
- **Frontend Production Build**: Vite build passes 100% green with Rollup chunks.
