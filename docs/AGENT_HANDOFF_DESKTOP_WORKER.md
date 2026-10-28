# Autonomous Agent Handoff: Desktop Worker & Extension Engine

> **Document Type**: Agent Handoff & Implementation Playbook  
> **Target Audience**: Incoming Autonomous AI Agents, Senior Backend/Full-Stack Developers, and DevOps Engineers.  
> **Primary Workspaces**: [`desktop/`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/desktop), [`released/`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/released), and [`docs/`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/docs)  
> **Related Specifications**: [`docs/DESKTOP_WORKER_AND_EXTENSION_SPEC.md`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/docs/DESKTOP_WORKER_AND_EXTENSION_SPEC.md), [`docs/RATE_CARD_SCRAPER_SPEC.md`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/docs/RATE_CARD_SCRAPER_SPEC.md)

---

## 1. Subsystem Mission & Scope

The **ReconCentral Desktop Worker & Extension Engine** provides an autonomous, cross-platform bridge between external marketplace seller portals (Flipkart Seller Hub, Shopsy Marketplace) and VB Exports' PostgreSQL financial database.

### Why It Exists Outside the Core Web App
1. **Cloudflare & Marketplace Bot Defenses**: Marketplace seller panels actively block cloud datacenter IP ranges (AWS, DigitalOcean, Hostinger). Running the scraper on local worker workstations or dedicated Linux nodes with residential/commercial IPs avoids CAPTCHAs and cloud IP blocks.
2. **Interactive 2FA Session Preservation**: Operations staff can perform 2FA login via an interactive Chromium window once. The session cookies are encrypted locally with AES-256-GCM and reused for automated background checks.
3. **Offline Database Extension**: Allows operators and analysts to query, inspect, filter, and batch-update allowed tables (`orders`, `settlements`, `returns`, `sku_master`, rate cards) directly through parameterized, SQL-injection-safe desktop APIs.

---

## 2. Repository Topology & File Map

```
DashBorad Project/
├── desktop/
│   ├── ui/                         # HTML/JS/CSS for Electron UI & Web Control Center
│   │   ├── index.html              # Main dashboard UI
│   │   ├── app.js                  # Frontend UI logic, tabs, and API triggers
│   │   └── style.css               # Clean styling adhering to Brand Burgundy system
│   ├── tests/
│   │   └── test_desktop_auth.js    # Comprehensive test suite (8 verification checks)
│   ├── scripts/
│   │   └── prepare-release.js      # Build automation script (Electron Builder packaging)
│   ├── authValidation.js           # Firebase JWT verification, role normalization, claims
│   ├── chromeFinder.js             # Cross-platform Chrome/Chromium executable locator
│   ├── cookieVault.js              # AES-256-GCM cookie encryption & OS user-data directory resolution
│   ├── db.js                       # Resilient PostgreSQL pool & Extension Engine (download/upload)
│   ├── desktopServer.mjs           # Standalone HTTP REST API & background daemon runner
│   ├── excelExport.js              # 6-sheet Microsoft Excel workbook generator
│   ├── main.js                     # Electron Main process, window management, and IPC bridge
│   ├── package.json                # Desktop dependencies (type: module)
│   ├── rateCardService.js          # Puppeteer scraper, DOM selectors, diffing, auto-closure sync
│   └── worker.js                   # Lightweight CLI entrypoint for crons or manual commands
└── released/
    ├── ReconCentral-RateCard-Worker-Setup.exe      # Windows NSIS installer (~81.8 MB)
    ├── ReconCentral-RateCard-Worker-Portable.exe   # Standalone portable Windows executable (~81.7 MB)
    ├── INSTALLATION_AND_AUTHORIZATION_GUIDE.md     # User setup manual
    └── linux/
        └── install-linux.sh                        # Linux installer & systemd service config
```

### Key Source Files & Functions

- **[`desktop/main.js`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/desktop/main.js)**:
  - `ipcMain.handle('download-database-details', ...)`: Exposes safe table downloads to the UI.
  - `ipcMain.handle('upload-database-details', ...)`: Role-gated upserts to allowed tables.
  - `ipcMain.handle('auth-login', ...)`: Authenticates against Firebase and provisions database credentials.
  - `ipcMain.handle('sync-brand-rate-cards', ...)`: Commits scraped rates with auto-closing dates.
- **[`desktop/db.js`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/desktop/db.js)**:
  - `downloadTableDetails(tableName, options)`: Dynamic parameterized SELECT queries.
  - `uploadTableUpdates(tableName, rows, keyColumns)`: Atomic transactional UPSERT queries.
  - `ALLOWED_TABLES`: Strict Set of 10 permitted table names.
- **[`desktop/cookieVault.js`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/desktop/cookieVault.js)**:
  - `saveEncryptedCookies(filePath, cookies)`: Encrypts cookies using AES-256-GCM with hardware ID salt.
  - `loadEncryptedCookies(filePath)`: Decrypts and parses stored cookies.
  - `getResolvedUserDataDir()`: Cross-platform user data path resolution (`%APPDATA%`, `~/.config`).
- **[`desktop/rateCardService.js`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/desktop/rateCardService.js)**:
  - `syncBrandRateCardsToDatabase(pool, brandRateCards, options)`: Auto-closes existing rate card records and inserts active rates.
  - `detectBrandRateChanges(pool, brandRateCards)`: Computes field-level differences between scraped and active rates.
- **[`desktop/authValidation.js`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/desktop/authValidation.js)**:
  - `normalizeRole(rawRole)`: Normalizes `owner`, `admin`, `operator`, `analyst` aliases.
  - `isAuthorizedDesktopRole(role)`: Allows read/scrape actions.
  - `isAuthorizedMutationRole(role)`: Restricts database mutations to `admin` and `operator`.

---

## 3. Core Architectural Invariants (Non-Negotiables)

Whenever modifying or extending the desktop worker, you **MUST** uphold these rules:

1. **Self-Contained ASAR Packaging (Zero Relative Backend Imports)**:
   - When Electron packages `desktop/` into `app.asar`, `../backend/` does not exist in the final build.
   - **Never write** `import ... from '../backend/...'` inside any desktop runtime file.
   - Any helper needed from the backend must be implemented directly inside `desktop/` (like [`desktop/cookieVault.js`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/desktop/cookieVault.js)).
   - Optional backend modules must use dynamic import with safe catch: `import('../backend/...').catch(() => null)`.
2. **Release Directory Cleanliness**:
   - All built Windows installers, portable executables, and Linux deployment files strictly output to **`released/`**.
   - The directory `relased/` was a legacy typo and is **permanently prohibited**.
3. **Shopsy Rate Invariant**:
   - Shopsy marketplace commission is **strictly 0.00%** across all order values, categories, and brands.
   - Never apply Flipkart standard category commission tiers to Shopsy listings.
4. **Rate Card Auto-Closure Rule**:
   - The PostgreSQL tables (`rc_commission`, `rc_fixed_fee`, `rc_reverse_shipping`) enforce `CHECK (end_date IS NULL OR end_date >= start_date)`.
   - When new rates become active on `new_start_date`, prior active rates (`end_date IS NULL` or `end_date >= new_start_date`) must be closed with `end_date = dayBefore(new_start_date)`.
   - If an existing record has `start_date >= new_start_date`, it must be deleted to allow the incoming version to overwrite it.
5. **Database Parameter Batching & SQL Injection Defense**:
   - All dynamic table queries must use parameterized placeholders (`$1, $2, ...`).
   - Table names and column names must be validated against `/^[a-zA-Z_][a-zA-Z0-9_]*$/`.
   - Batch operations must be chunked to avoid PostgreSQL's 65,535 parameter limit.
6. **Zero Hardcoded Secrets in Distribution**:
   - Neither `ReconCentral-RateCard-Worker-Setup.exe` nor `worker-config.json` in source control may contain database passwords or secrets.
   - Credentials are dynamically provisioned over TLS after Firebase token verification.
7. **Strict Linux File Permissions**:
   - Linux runtime directories (`/etc/reconcentral-ratecard`, `/opt/reconcentral-ratecard`) must have permissions `0700`.
   - Configuration files containing connection strings must have permissions `0600`.
8. **Mandatory CodeAnt AI Review on All PRs**:
   - All changes must be proposed via dedicated PR branches.
   - No branch may be merged into `master` until **CodeAnt AI** reviews and passes the diff, and all tests pass 100% green.
9. **TaskFlow Pro Synchronous Tracking**:
   - Call `sync_coding_work` on the `taskflow-pro` MCP server at session start and milestone completions.

---

## 4. How to Run, Test, and Build

### 4.1 Running the Verification Suite
Execute the autonomous 8-check auth and security test suite:
```bash
node desktop/tests/test_desktop_auth.js
```
Expected output:
```text
=== RECONCENTRAL DESKTOP AUTH & EXTENSION TEST SUITE ===
[Test 1] Role normalization logic... PASS
[Test 2] Channel rate card filtering... PASS
[Test 3] AES-256-GCM cookie vault encryption... PASS
[Test 4] Firebase JWT token decoding... PASS
[Test 5] Database role verification... PASS
[Test 6] Auth session file security... PASS
[Test 7] Zero hardcoded secrets audit... PASS
[Test 8] Extension engine allowlist & SQL validation... PASS
=== ALL 8 VERIFICATION CHECKS PASSED (100% GREEN) ===
```

### 4.2 Running the Full Codebase Test Suite
```bash
# In backend directory:
npm test

# In frontend directory:
npm run build
```

### 4.3 Running Desktop Locally in Development
```bash
cd desktop

# Launch Electron desktop GUI:
npm start

# Or launch standalone headless server:
node desktopServer.mjs --port=3388

# Or run single CLI scrape test:
node worker.js --marketplace=shopsy --dry-run
```

### 4.4 Packaging Windows Release Binaries
```bash
node desktop/scripts/prepare-release.js
```
Outputs:
- `released/ReconCentral-RateCard-Worker-Setup.exe`
- `released/ReconCentral-RateCard-Worker-Portable.exe`
- Desktop shortcut on current workstation.

### 4.5 Deploying to Linux
```bash
# On target Linux server (Ubuntu/Debian/RHEL):
sudo bash released/linux/install-linux.sh

# Verify systemd service:
systemctl status reconcentral-ratecard
```

---

## 5. Developer Playbooks

### Playbook 1: How to Add a New Allowlisted Table to the Desktop Extension Engine

If you need the desktop worker to query or update a new database table (e.g. `mp_invoices` or `sor_invoice`):

1. **Update Allowed Set in [`desktop/db.js`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/desktop/db.js)**:
   ```javascript
   export const ALLOWED_TABLES = new Set([
     'orders',
     'returns',
     'settlements',
     'rc_commission',
     'rc_fixed_fee',
     'rc_collection_fee',
     'rc_reverse_shipping',
     'rate_card_versions',
     'sku_master',
     'vb_sku_master',
     'sor_invoice' // <-- Add new table here
   ]);
   ```
2. **Update IPC Bridges in [`desktop/main.js`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/desktop/main.js)**:
   Verify that `download-database-details` and `upload-database-details` enforce appropriate role gates (`isAuthorizedDesktopRole` for reads, `isAuthorizedMutationRole` for writes).
3. **Update Test Suite in [`desktop/tests/test_desktop_auth.js`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/desktop/tests/test_desktop_auth.js)**:
   Add the new table name to the test assertion verifying `ALLOWED_TABLES`.
4. **Document the Table in [`docs/DESKTOP_WORKER_AND_EXTENSION_SPEC.md`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/docs/DESKTOP_WORKER_AND_EXTENSION_SPEC.md)**.

---

### Playbook 2: How to Add a New Marketplace Portal to the Desktop Scraper

To add an automated scraper for a new marketplace (e.g. **Meesho** or **Reliance AJIO**):

1. **Register the Portal in [`desktop/main.js`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/desktop/main.js)**:
   Add entry to `SUPPORTED_MARKETPLACES` with `id`, `name`, and login portal URL.
2. **Implement Scraper Function in [`desktop/rateCardService.js`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/desktop/rateCardService.js)**:
   - Accept `page`, `category`, and `account` parameters.
   - Use `page.waitForSelector` with a non-blocking timeout.
   - Extract fee slabs into standardized rate objects (`{ category, marketplace, rate, price_min, price_max, start_date }`).
3. **Register Cookie Storage Path**:
   Use `cookieVault.js` with `getMarketplaceCookiesPath(portalId)` to store cookies in isolated files (`cookies_meesho.json`).
4. **Implement Auto-Closure Sync Logic**:
   Ensure `syncBrandRateCardsToDatabase` handles the new `marketplace` key and computes `dayBefore` closure dates.

---

### Playbook 3: How to Add a New IPC Channel

To expose a new capability from Node/Electron main to the UI renderer:

1. **Define Handler in [`desktop/main.js`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/desktop/main.js)**:
   ```javascript
   ipcMain.handle('custom-operation', async (event, payload) => {
     const session = loadAuthSession();
     if (!session?.authenticated || !isAuthorizedDesktopRole(session?.user?.role)) {
       return { success: false, error: 'Unauthorized' };
     }
     try {
       // Perform operation...
       return { success: true, data: result };
     } catch (err) {
       return { success: false, error: err.message };
     }
   });
   ```
2. **Expose Channel in [`desktop/preload.cjs`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/desktop/preload.cjs)** (if context isolation enabled):
   Add function to `window.desktopBridge`.
3. **Invoke from [`desktop/ui/app.js`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/desktop/ui/app.js)**:
   ```javascript
   const res = await window.electronAPI.invoke('custom-operation', { ... });
   ```

---

## 6. Troubleshooting & Common Failure Modes

| Issue | Root Cause | Remediation |
| :--- | :--- | :--- |
| **`ERR_MODULE_NOT_FOUND` in Packaged App** | Relative path traversal into `../backend/` inside `desktop/` code. | Isolate utility directly in `desktop/` (e.g. `cookieVault.js`) or use dynamic optional import `.catch(() => null)`. |
| **Check constraint `rc_commission_dates_ok` violated** | Attempting to update `end_date` to a date prior to `start_date`. | In `syncBrandRateCardsToDatabase`, only update `end_date = dayBefore` if `start_date < new_start_date`. If `start_date >= new_start_date`, delete the overlapping record. |
| **`protocol error (invalid connection)` on PostgreSQL WAN** | Network reset or idle timeout on remote PostgreSQL server. | `getDesktopPool()` in `desktop/db.js` includes idle timeouts (`idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 15000`) and handles background pool errors. |
| **Chrome not found on Linux server** | Neither `google-chrome` nor `chromium` installed in system path. | Run `sudo apt-get install chromium-browser` or set `CHROME_BIN=/usr/bin/chromium` in `/etc/environment`. |
| **PostgreSQL parameter limit exceeded (65535)** | Bulk upsert contains more than 65,535 parameters in one query. | Chunk the rows array into batches (e.g. 100 rows per query) before calling `client.query`. |

---

## 7. Mandatory TaskFlow Pro Tracking Contract

Every AI agent or developer session **must** integrate with TaskFlow Pro:

1. **Initial Call**:
   ```json
   {
     "project_name": "DashBorad Project",
     "task_title": "<Specific title of current work>",
     "task_description": "<Context and goals>",
     "status": "in_progress"
   }
   ```
2. **Progress Milestone**:
   ```json
   {
     "project_name": "DashBorad Project",
     "task_id": "<Task UUID>",
     "task_title": "<Specific title>",
     "task_description": "<Context>",
     "progress_note": "<Milestone details>",
     "status": "in_progress"
   }
   ```
3. **PR Ready for Review**:
   ```json
   {
     "status": "in_review",
     "progress_note": "PR opened. Tests passing. Awaiting CodeAnt AI review."
   }
   ```
4. **Completed & Merged**:
   ```json
   {
     "status": "done",
     "progress_note": "Verified by CodeAnt AI, all tests green, PR merged into master."
   }
   ```

---

## 8. Git & Pull Request Checklist

Before submitting a PR:
- [ ] Working branch created from up-to-date `master` (`git checkout master && git pull; git checkout -b <branch>`).
- [ ] Verification tests passing (`node desktop/tests/test_desktop_auth.js`).
- [ ] Backend test suite passing (`npm test` in `backend`).
- [ ] Frontend build passing (`npm run build` in `frontend`).
- [ ] Zero secrets in commit diff (no hardcoded API keys, database passwords, or unmasked tokens).
- [ ] Zero relative imports from `desktop/` to `../backend/`.
- [ ] PR created and reviewed by **CodeAnt AI**.
