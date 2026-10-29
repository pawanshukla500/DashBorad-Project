# ReconCentral: Rate Card Scraper, Desktop Engine & REST API Specification

> **Target Audience**: Autonomous AI Agents (LLMs), Software Architects, DevOps Engineers, and ReconCentral Developers.
> **Scope**: Complete architecture, data structures, DOM selectors, session management, fee calculations, cross-platform execution (Windows & Linux), and REST API endpoints for Flipkart & Shopsy rate card automation.

---

## 1. Executive Overview & Core Objective

The ReconCentral Rate Card Engine automates the discovery, extraction, change detection, database synchronization, and spreadsheet generation of marketplace fee rate cards across **Flipkart Seller Hub** and **Shopsy Marketplace**.

Historically, marketplace fee rate cards were manually inspected or entered into spreadsheets, causing calculation drift, missed fee hikes, and reconciliation errors. This engine:
1. Dynamically queries live order history in PostgreSQL to find active **Product Verticals**, **Seller Brands**, and **Sample FSNs/SKUs**.
2. Scrapes or models official marketplace rate cards for every brand and category.
3. Enforces verified fee structures (including Shopsy's **0% commission** policy, **tiered closing fee**, and **reverse return shipping fee**).
4. Compares live rates against active PostgreSQL database records (`rc_commission`, `rc_fixed_fee`, `rc_reverse_shipping`).
5. Commits updates to the database with mathematical period auto-closing (`end_date = dayBefore(new_start_date)`), strictly respecting check constraints.
6. Generates a formatted 6-sheet Microsoft Excel workbook on the user's Desktop.
7. Operates cross-platform on **Windows** and **Linux** workstations or headless servers via CLI, REST API, or Desktop GUI.

---

## 2. Marketplace Channel Fee Structures & Invariants

### 2.1 Shopsy Marketplace Fee Structure

Flipkart operates Shopsy as an ultra-low-cost sub-channel for fashion and lifestyle products. The fee policy has specific invariants:

| Fee Component | Value / Rule | Database Schema Table | Column Mappings |
| :--- | :--- | :--- | :--- |
| **Marketplace Commission** | **Flat 0.00%** across all order values, brands, and categories | `rc_commission` | `marketplace = 'shopsy'`, `rate = 0.000000`, `price_min = 0`, `price_max = 999999` |
| **Fixed Fee (Closing Fee)** | Tiered by Order Item Value:<br>• **₹0** for order item value ≤ ₹1,500<br>• **₹10** for order item value &gt; ₹1,500<br>*(Applies across all seller tiers: Bronze, Silver, Gold, Diamond)* | `rc_fixed_fee` | `marketplace = 'shopsy'`, `fulfilment_type IN ('Bronze','Silver','Gold','Diamond')`, `price_min/max`, `rate = 0` or `10` |
| **Reverse Shipping Fee (Return Fee)** | Charged when a customer return or courier return occurs. Tiered by weight and price bracket: | `rc_reverse_shipping` | `marketplace = 'shopsy'`, `weight_slab`, `price_min/max`, `local_fee`, `zonal_fee`, `national_fee` |
| ↳ *0kg - 0.5kg slab* | • ₹0 - ₹500: Local ₹122, Zonal ₹142, National ₹182<br>• ₹501 - ₹1000: Local ₹147, Zonal ₹167, National ₹207<br>• &gt; ₹1000: Local ₹157, Zonal ₹177, National ₹217 | `rc_reverse_shipping` | `weight_slab = '0kg-0.5kg'` |
| ↳ *0.5kg - 1.0kg slab* | • ₹0 - ₹500: Local ₹152, Zonal ₹177, National ₹227<br>• ₹501 - ₹1000: Local ₹177, Zonal ₹202, National ₹252<br>• &gt; ₹1000: Local ₹187, Zonal ₹212, National ₹262 | `rc_reverse_shipping` | `weight_slab = '0.5kg-1kg'` |
| **Payment Collection Fee** | **₹0 Prepaid / ₹0 Postpaid** (waived on Shopsy) | `rc_collection_fee` | `prepaid = 0`, `postpaid = 0` |

### 2.2 Flipkart Standard Marketplace Fee Structure

Flipkart Standard marketplace charges commissions that depend on the **Brand** and **Category**:

1. **Ethnic Junction** & **Youthnic**:
   - Zero-commission incentive rate: `0.00%` across all order values for Kurta, Ethnic Sets, Saris, and Tops.
2. **Sangria** (Tiered Commission Schedule):
   - **Kurta & Ethnic Sets**:
     - `₹0 - ₹500`: **0.00%**
     - `₹501 - ₹800`: **2.00%** (`0.02`)
     - `₹801 - ₹1,000`: **4.00%** (`0.04`)
     - `₹1,001 - ₹10,000`: **10.00%** (`0.10`)
     - `> ₹10,000`: **0.00%**
   - **Tops & Apparel Sets**:
     - `₹0 - ₹500`: **0.00%**
     - `₹501 - ₹800`: **2.00%** (`0.02`)
     - `₹801 - ₹1,000`: **4.00%** (`0.04`)
     - `₹1,001 - ₹10,000`: **13.00%** (`0.13`)
     - `> ₹10,000`: **0.00%**
3. **Divastri** & **General / All Brands**:
   - Uses category standard vertical rate.
4. **Fixed Fees**:
   - ₹0 for order value ≤ ₹1,500; ₹10 for order value > ₹1,500 across tiers.
5. **Reverse Shipping**:
   - `0kg-0.5kg` and `0.5kg-1kg` weight slabs with local, zonal, and national tiers.

---

## 3. Database Architecture & Constraint Invariants

### 3.1 PostgreSQL Tables

```sql
-- 1. Commission Table
CREATE TABLE rc_commission (
    id SERIAL PRIMARY KEY,
    category VARCHAR(100) NOT NULL,
    marketplace VARCHAR(50) NOT NULL DEFAULT 'flipkart',
    seller_account VARCHAR(50) NOT NULL DEFAULT 'default',
    brand_name VARCHAR(100), -- NULL or 'General' applies to all brands; specific brand overrides
    price_min NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    price_max NUMERIC(10,2) NOT NULL DEFAULT 999999.00,
    rate NUMERIC(10,6) NOT NULL, -- e.g. 0.14 for 14%, 0.00 for 0%
    start_date DATE NOT NULL,
    end_date DATE, -- NULL indicates active ongoing period
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT rc_commission_dates_ok CHECK (end_date IS NULL OR end_date >= start_date)
);

-- 2. Fixed Fee (Closing Fee) Table
CREATE TABLE rc_fixed_fee (
    id SERIAL PRIMARY KEY,
    category VARCHAR(100) NOT NULL,
    marketplace VARCHAR(50) NOT NULL DEFAULT 'flipkart',
    seller_account VARCHAR(50) NOT NULL DEFAULT 'default',
    fulfilment_type VARCHAR(50) NOT NULL DEFAULT 'Bronze', -- Bronze / Silver / Gold / Diamond / All
    price_min NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    price_max NUMERIC(10,2) NOT NULL DEFAULT 999999.00,
    rate NUMERIC(10,2) NOT NULL, -- Flat rupee amount (e.g. 0.00 or 10.00)
    start_date DATE NOT NULL,
    end_date DATE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT rc_fixed_fee_dates_ok CHECK (end_date IS NULL OR end_date >= start_date)
);

-- 3. Reverse Shipping Fee Table
CREATE TABLE rc_reverse_shipping (
    id SERIAL PRIMARY KEY,
    category VARCHAR(100) NOT NULL,
    marketplace VARCHAR(50) NOT NULL DEFAULT 'flipkart',
    seller_account VARCHAR(50) NOT NULL DEFAULT 'default',
    weight_slab VARCHAR(50) NOT NULL, -- '0kg-0.5kg', '0.5kg-1kg'
    price_min NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    price_max NUMERIC(10,2) NOT NULL DEFAULT 999999.00,
    local_fee NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    zonal_fee NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    national_fee NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    start_date DATE NOT NULL,
    end_date DATE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT rc_reverse_shipping_dates_ok CHECK (end_date IS NULL OR end_date >= start_date)
);

-- 4. Rate Card Versions (Audit Log)
CREATE TABLE rate_card_versions (
    id SERIAL PRIMARY KEY,
    marketplace VARCHAR(50) NOT NULL,
    seller_account VARCHAR(50) NOT NULL DEFAULT 'default',
    version_name VARCHAR(150) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'published',
    effective_from DATE NOT NULL,
    snapshot JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    published_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.2 Architectural Invariant: Date Auto-Closing & Idempotency

> [!IMPORTANT]
> The database has check constraints `CHECK (end_date IS NULL OR end_date >= start_date)`.
> If a rate was already inserted today (`start_date = 2026-10-27`), attempting to close it with `end_date = dayBefore(today)` (`2026-10-26`) will trigger an SQL check constraint violation!

**Correct Implementation Rule** (see [`brandRateCardService.js:syncBrandRateCardsToDatabase`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/backend/services/brandRateCardService.js#L309-L330)):
1. **Delete any same-day rows**:
   ```sql
   DELETE FROM rc_commission 
   WHERE marketplace = $1 AND category = $2 AND start_date = $3::date AND end_date IS NULL;
   ```
2. **Auto-close earlier rows**:
   ```sql
   UPDATE rc_commission 
   SET end_date = ($3::date - INTERVAL '1 day')::date, updated_at = NOW()
   WHERE marketplace = $1 AND category = $2 
     AND start_date < $3::date 
     AND (end_date IS NULL OR end_date >= $3::date);
   ```
3. **Insert new active row**:
   ```sql
   INSERT INTO rc_commission (category, marketplace, seller_account, brand_name, price_min, price_max, rate, start_date, end_date, updated_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, NULL, NOW());
   ```

---

## 4. Scraping Lifecycle & DOM Selectors

### 4.1 URL Pattern
Flipkart Seller Hub serves rate cards via single-page application hash routing:
```
https://seller.flipkart.com/index.html#dashboard/payments/rate-card?query={"marketplace":"flipkart","fulfillment":"non-fbf","date":"YYYY-MM-DD 12:00:00","vertical":"<category>"}
```
- For Shopsy:
```
https://seller.flipkart.com/index.html#dashboard/payments/rate-card?query={"marketplace":"shopsy","fulfillment":"non-fbf","date":"YYYY-MM-DD 12:00:00","vertical":"shopsy_<category>"}
```

### 4.2 Authentication Flow
1. **Cached Session**: The engine looks for saved cookies in `.runtime/cookies.json` or `userData/cookies.json`.
2. **Session Verification**: Navigates to `https://seller.flipkart.com/index.html#dashboard/home-page`. Checks if page body contains `'EthnicJunction'`, `'Seller Dashboard'`, or `'Logout'`.
3. **Automated Login (if configured)**:
   - Types username into `input[name="username"]`
   - Clicks `'Next'` button
   - Types password into `input[name="password"]`
   - Clicks `'Login'` button
   - Waits for dashboard navigation and dumps updated cookies to `cookies.json`.
4. **Interactive Human Login (2FA / OTP Mode)**:
   - Launches Google Chrome with `headless: false` and `--start-maximized`.
   - Directs to `https://seller.flipkart.com/` and waits up to 5 minutes for the user to complete OTP or 2FA.
   - Automatically serializes the authenticated cookies once login completes.

### 4.3 Table Extraction & DOM Selectors
The rate card page renders tables for fee categories:
1. **Commission Table**:
   - Header contains `order item value` and `fee charged`.
   - Cell contains `%` symbol.
2. **Fixed Fee Table**:
   - Header contains `order item value` and `fee charged`.
   - Cell contains `₹` currency amounts.
3. **Collection Fee Table**:
   - Header contains `prepaid` and `postpaid`.
4. **Reverse Shipping Table**:
   - Header contains `weight` and (`local` or `base rates`).
   - Slabs parsed: `0kg-0.5kg` and `0.5kg-1kg`.

---

## 5. Cross-Platform PC Application & Launchers

### 5.1 Operating System Compatibility
The application runs on both **Windows** and **Linux**:

| Feature | Windows (`win32`) | Linux (`linux`) |
| :--- | :--- | :--- |
| **Launch Script** | [`start-ratecard-desktop.bat`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/start-ratecard-desktop.bat) | [`start-ratecard-desktop.sh`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/start-ratecard-desktop.sh) |
| **Desktop Shortcut** | `C:\Users\Pawan Shukla\Desktop\Start_RateCard_Desktop.bat` | Symlink / Desktop Entry |
| **Chrome Search Paths** | `C:\Program Files\Google\Chrome\Application\chrome.exe`<br>`C:\Program Files (x86)\...`<br>`%LOCALAPPDATA%\Google\Chrome\...`<br>`Microsoft Edge` | `/usr/bin/google-chrome`<br>`/usr/bin/google-chrome-stable`<br>`/usr/bin/chromium`<br>`/usr/bin/chromium-browser`<br>`/snap/bin/chromium` |
| **Puppeteer Flags** | `--no-sandbox`<br>`--disable-setuid-sandbox` | `--no-sandbox`<br>`--disable-setuid-sandbox`<br>`--disable-dev-shm-usage`<br>`--disable-gpu`<br>`--no-zygote` |
| **File Launcher** | `start "" "<path>"` | `xdg-open "<path>"` |
| **UI Mode** | Frameless Chrome App (`--app=http://localhost:3388`) | Frameless Chrome App (X11/Wayland) or Web URL (Headless Server) |

### 5.2 Launch Instructions

#### On Windows:
Double-click `Start_RateCard_Desktop.bat` on your Desktop, or run in PowerShell:
```cmd
.\start-ratecard-desktop.bat
```

#### On Linux:
Mark executable and run:
```bash
chmod +x start-ratecard-desktop.sh
./start-ratecard-desktop.sh
```

#### Standalone Headless CLI Worker (Any OS):
```bash
# Preview rates and run change detection
node desktop/worker.js --marketplace=both

# Commit rates to PostgreSQL database and generate Excel file
node desktop/worker.js --marketplace=both --auto-sync --export-excel

# Shopsy specific extraction
node desktop/worker.js --marketplace=shopsy --export-excel
```

---

## 6. Complete REST API Specifications (GET & POST)

The desktop server (`desktop/desktopServer.mjs`) exposes a full REST API on port `3388`:

### 6.1 `GET /api/health`
Returns system status, operating system platform, Chrome availability, and database connection.

**Response**:
```json
{
  "status": "ok",
  "platform": "win32",
  "arch": "x64",
  "nodeVersion": "v24.19.0",
  "uptimeSeconds": 142,
  "chromeExecutable": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "chromeAvailable": true,
  "databaseConnected": true,
  "activeScrapeJob": {
    "running": false,
    "status": "idle"
  }
}
```

---

### 6.2 `GET /api/config`
Retrieves current configuration.

**Response**:
```json
{
  "marketplace": "both",
  "email": "Vbexports@outlook.com",
  "databaseUrl": "postgresql://...",
  "scheduledHour": 6,
  "scheduledMinute": 0,
  "autoSyncToDb": false,
  "selectedBrands": ["Ethnic Junction", "Youthnic", "Sangria", "Divastri", "General"],
  "selectedVerticals": ["ethnic_set", "kurta", "sari", "top", "fabric", "shopsy_kurta", "shopsy_ethnic_set"]
}
```

---

### 6.3 `POST /api/config`
Updates and saves configuration to `worker-config.json`.

**Request Body**:
```json
{
  "marketplace": "both",
  "email": "Vbexports@outlook.com",
  "scheduledHour": 7,
  "autoSyncToDb": true
}
```

---

### 6.4 `GET /api/catalog`
Queries live PostgreSQL order history and returns distinct categories, brands, sample FSNs, sample SKUs, and order volumes.

**Response**:
```json
{
  "success": true,
  "count": 32,
  "catalog": [
    {
      "marketplace": "flipkart",
      "category": "ethnic_set",
      "brand": "Youthnic",
      "sample_fsn": "ETHHF8U9XFH2YYGF",
      "sample_sku": "EJ1201-16001-M",
      "order_count": 8420
    },
    {
      "marketplace": "shopsy",
      "category": "shopsy_ethnic_set",
      "brand": "Ethnic Junction",
      "sample_fsn": "SARHGTGFN2MVPJA2",
      "sample_sku": "SH-EJ991-S",
      "order_count": 1240
    }
  ]
}
```

---

### 6.5 `GET /api/preview`
Generates the complete brand-wise rate card models for Flipkart and Shopsy.

**Response**:
```json
{
  "success": true,
  "count": 32,
  "rateCards": [
    {
      "marketplace": "shopsy",
      "category": "shopsy_ethnic_set",
      "brand": "Ethnic Junction",
      "sample_fsn": "SARHGTGFN2MVPJA2",
      "commissions": [
        { "price_min": 0, "price_max": 999999, "rate": 0.0 }
      ],
      "fixedFees": [
        { "fulfilment_type": "Bronze", "price_min": 0, "price_max": 1500, "rate": 0 },
        { "fulfilment_type": "Bronze", "price_min": 1501, "price_max": 999999, "rate": 10 }
      ],
      "reverseShipping": [
        { "weight_slab": "0kg-0.5kg", "price_min": 0, "price_max": 500, "local_fee": 122, "zonal_fee": 142, "national_fee": 182 }
      ]
    }
  ]
}
```

---

### 6.6 `GET /api/active-rates`
Retrieves currently active database rows from `rc_commission`, `rc_fixed_fee`, and `rc_reverse_shipping`.

**Response**:
```json
{
  "success": true,
  "counts": {
    "commissions": 186,
    "fixedFees": 236,
    "reverseShipping": 100
  },
  "rates": { ... }
}
```

---

### 6.7 `GET /api/diff`
Runs change detection comparing current rate models against active database rows.

**Response**:
```json
{
  "success": true,
  "inSync": true,
  "changesCount": 0,
  "changes": []
}
```

---

### 6.8 `POST /api/sync`
Commits rate cards to PostgreSQL database with automatic date closing.

**Request Body**:
```json
{
  "rateCards": [ ... ],
  "options": {
    "effectiveDate": "2026-10-27",
    "sellerAccount": "default"
  }
}
```

**Response**:
```json
{
  "success": true,
  "result": {
    "updated": true,
    "message": "Successfully synchronized 32 brand-wise rate cards across Flipkart and Shopsy.",
    "changesCount": 0,
    "insertedCommissions": 186,
    "insertedFixed": 236,
    "insertedRev": 100,
    "versionName": "brand-fsn-sync-2026-10-27-8492"
  }
}
```

---

### 6.9 `POST /api/scrape/start`
Starts a scraping job. Runs asynchronously and broadcasts progress over Server-Sent Events (`/api/events`).

**Request Body**:
```json
{
  "marketplace": "both",
  "mode": "visible",
  "brands": ["Ethnic Junction", "Youthnic", "Sangria"],
  "verticals": ["ethnic_set", "kurta", "shopsy_ethnic_set"]
}
```

**Response (HTTP 202 Accepted)**:
```json
{
  "success": true,
  "message": "Scraping job started successfully.",
  "job": {
    "running": true,
    "status": "running",
    "startedAt": "2026-10-27T07:45:00.000Z"
  }
}
```

---

### 6.10 `GET /api/scrape/status`
Checks the progress and state of the active scraping job.

---

### 6.11 `POST /api/export-excel`
Generates the multi-sheet Microsoft Excel workbook on disk.

**Request Body** (optional path):
```json
{
  "path": "C:\\Users\\Pawan Shukla\\Desktop\\Flipkart_Shopsy_Brandwise_RateCard.xlsx"
}
```

**Response**:
```json
{
  "success": true,
  "filePath": "C:\\Users\\Pawan Shukla\\Desktop\\Flipkart_Shopsy_Brandwise_RateCard.xlsx",
  "sheetsCount": 6,
  "sheets": [
    "Brand_Commission_Summary",
    "Flipkart_Rates",
    "Shopsy_Rates",
    "Fixed_Fees",
    "Reverse_Shipping",
    "Sample_FSN_Catalog"
  ],
  "totalRecords": 64,
  "catalogCount": 32
}
```

---

### 6.12 `POST /api/open-excel`
Cross-platform system command to launch the generated Excel file in Microsoft Excel or default spreadsheet viewer.

---

### 6.13 `GET /api/events`
Server-Sent Events (SSE) telemetry stream providing real-time console messages to the UI or any listening client.

---

## 7. Multi-Sheet Excel Structure

The generated Excel workbook at `C:\Users\Pawan Shukla\Desktop\Flipkart_Shopsy_Brandwise_RateCard.xlsx` contains 6 sheets:

1. **`Brand_Commission_Summary`**: Overview matrix comparing commission rates across Sangria, Ethnic Junction, Youthnic, Divastri, and Shopsy.
2. **`Flipkart_Rates`**: Active price slabs and rates for Flipkart Standard.
3. **`Shopsy_Rates`**: Verified 0% commission slabs for Shopsy.
4. **`Fixed_Fees`**: Tiered closing fee breakdown (₹0 for ≤ ₹1,500, ₹10 for > ₹1,500 across Bronze, Silver, Gold, Diamond).
5. **`Reverse_Shipping`**: Return shipping charges for `0kg-0.5kg` and `0.5kg-1kg` slabs by order value and zone (Local, Zonal, National).
6. **`Sample_FSN_Catalog`**: Live mapping of Category, Brand, Sample FSN, Sample SKU, and historical order volumes.

---

## 8. Maintenance & Extension Guide for AI Agents

Whenever an AI model is asked to add a new marketplace, category, or fee component:
1. **Never create synthetic identifiers**: Use genuine sample FSNs and SKUs from PostgreSQL `orders`.
2. **Maintain check constraint safety**: Always auto-close previous periods with `end_date = dayBefore(today)` and delete existing same-day records before inserting new rows.
3. **Preserve Shopsy Invariant**: Shopsy commission is always 0.00%. Do not assign Flipkart standard commission tiers to Shopsy listings.
4. **Retain Dual Execution**: Ensure all tools function both in native Electron and in standalone Chrome App Mode / CLI.
5. **Sync with TaskFlow Pro**: Call `sync_coding_work` at milestone boundaries and transition tasks through `in_progress` -> `in_review` -> `done`.

---

## 9. Windows Installer Release & Zero-Secret Security Architecture

### 9.1 Zero-Secret Installer Invariant
The production installer executable (`released/ReconCentral-RateCard-Worker-Setup.exe`) contains **zero hardcoded database credentials, passwords, or master secrets**.
1. **Packaging**: Electron Builder packages only the compiled UI, IPC handlers, and scraper engine. Sensitive configuration defaults to empty strings (`databaseUrl: process.env.DATABASE_URL || ''`).
2. **Dynamic TLS Provisioning**:
   - The user launches the installed application on their PC.
   - The user logs in with their ReconCentral Firebase credentials (e.g. `returnorders@vbexports.co.in`).
   - The desktop engine sends the Firebase `idToken` to the ReconCentral backend endpoint `GET /api/auth/desktop-config`.
   - The backend validates the ID token via `firebase-admin` and checks that `users.role` is in `['admin', 'operator', 'analyst']`. Admin/operator sessions receive the standard desktop database URL; analyst sessions receive only the separately configured `DESKTOP_ANALYST_DATABASE_URL`, which must use a PostgreSQL principal with read-only grants. It never falls back to the admin/operator URL.
   - The desktop worker clears any previously saved standard database URL when an analyst signs in, and accepts an analyst URL only when the server marks it `read-only`.
3. **OS Profile Isolation**:
   - The provisioned session is stored locally in the current user's roaming application directory (`%APPDATA%\ReconCentral RateCard Worker\worker-config.json` and `auth-session.json`).
   - This ensures credentials and active session state are protected by Windows OS user-level ACL permissions and never shared across PC user accounts.

### 9.2 Release Artifacts

All release files are deployed into the **`released/`** directory:

| Artifact | Format | Description |
| :--- | :--- | :--- |
| `ReconCentral-RateCard-Worker-Setup.exe` | NSIS Executable (~81.8 MB) | Production 1-click Windows installer with Desktop icon and uninstaller. |
| `ReconCentral-RateCard-Worker-Portable.exe` | Standalone Executable (~81.7 MB) | Portable single-file executable for standalone or USB execution. |
| `linux/install-linux.sh` | Shell Script | Automated Linux installer deploying binary to `/opt/` and creating systemd service. |
| `INSTALLATION_AND_AUTHORIZATION_GUIDE.md` | Markdown Manual | Operator manual for installation, login, and authorization. |

---

## 10. Marketplace Credentials Storage & Multi-Account Automation Architecture

### 10.1 Multi-Marketplace Accounts & Dual Myntra Separation Invariant
ReconCentral manages automated rate card scraping and ledger ingestion across 7 major marketplace channels (8 separate legal accounts):

1. **Amazon IN** (`amazon_in`): Seller Central India (`sellercentral.amazon.in`)
2. **Cocoblu Retails** (`cocoblu`): Cocoblu Vendor Portal (`vendor.cocoblu.biz`)
3. **Myntra VB** (`myntra_vb`): Partner Portal (`partners.myntra.com`) - **Seller ID `10708`** (VB Exports)
4. **Myntra EJ** (`myntra_ej`): Partner Portal (`partners.myntra.com`) - **Seller ID `45833`** (Ethnic Junction)
5. **Flipkart** (`flipkart`): Seller Hub (`seller.flipkart.com`)
6. **Reliance Retail (AJIO)** (`reliance_ajio`): AJIO Supplier Portal (`supplier.ajio.com`)
7. **Meesho** (`meesho`): Supplier Panel (`supplier.meesho.com`)
8. **Shopify** (`shopify`): Direct-to-Consumer Admin Portal (`admin.shopify.com`)

> [!IMPORTANT]
> **Strict Myntra Invariant**: Myntra accounts must remain strictly segregated into `myntra_vb` (Seller ID 10708) and `myntra_ej` (Seller ID 45833). Files or credentials uploaded to one account must never bleed into the other.

### 10.2 Cryptographic Security (AES-256-GCM)
Marketplace passwords and session secrets are encrypted in PostgreSQL via AES-256-GCM (`backend/utils/credentialCrypto.js`):
- **Initialization Vector**: Cryptographically secure random 12-byte IV per encryption operation.
- **Authentication Tag**: 16-byte GCM authentication tag for tamper resistance and integrity checking.
- **Zero Plaintext Leaks**: Passwords are masked (`••••••••`) across all standard API endpoints (`GET /api/marketplace-accounts`). Decryption is strictly restricted to authorized operators/admins via `GET /api/marketplace-accounts/:id/reveal` with immediate audit trail recording (`audit_log`).

### 10.3 Brandfetch Official Marketplace Logos
Official brand assets are resolved and cached via Brandfetch CDN:
- **Flipkart**: `https://cdn.brandfetch.io/idWdImNSUt/w/128/h/128/fallback/lettermark/icon.webp...`
- **Amazon IN**: `https://cdn.brandfetch.io/idomDO5Jzv/w/128/h/128/fallback/lettermark/icon.webp...`
- **Myntra**: `https://cdn.brandfetch.io/idDW82Qwj2/w/128/h/128/fallback/lettermark/icon.webp...`
- **Reliance AJIO**: `https://cdn.brandfetch.io/idr5xgDFc2/w/128/h/128/fallback/lettermark/icon.webp...`
- **Meesho**: `https://cdn.brandfetch.io/idyeTDctmi/w/128/h/128/fallback/lettermark/icon.webp...`
- **Cocoblu Retails**: `https://cdn.brandfetch.io/iduQ6iAglk/w/128/h/128/fallback/lettermark/icon.webp...`
- **Shopify**: `https://cdn.brandfetch.io/idAgPm7IvG/w/128/h/128/fallback/lettermark/icon.webp...`

### 10.4 Desktop Application Interactive Scraper Login
The desktop rate card worker communicates directly with the local engine (`http://localhost:3737/api/desktop/marketplace-accounts`):
1. **Channel Selection**: User selects the target marketplace account (e.g., `Flipkart`, `Myntra (VB)`, `Myntra (EJ)`).
2. **Interactive Browser Spawn**: Clicking **"Launch Interactive Login"** triggers `POST /api/interactive-login`, spawning an isolated Puppeteer Chromium window directed to the marketplace seller portal.
3. **Session Preservation**: Cookies and session state are persisted in `.runtime/cookies.json` and `%APPDATA%\ReconCentral RateCard Worker\`, enabling automated headless rate card verification without repeating 2FA on every scrape cycle.

---

## 11. Desktop Extension Engine & Packaging Architecture

### 11.1 Self-Contained ASAR Packaging Invariant
All desktop modules inside `desktop/` must remain completely self-contained. In production builds packaged with Electron Builder, `desktop/` is bundled into an ASAR archive. Relative path traversals such as `../backend/` fail with `ERR_MODULE_NOT_FOUND` in production. Any necessary utilities (e.g. `cookieVault.js`) are directly maintained in `desktop/`.

Release packages strictly output to `released/` (`released/ReconCentral-RateCard-Worker-Setup.exe`, `released/ReconCentral-RateCard-Worker-Portable.exe`, `released/linux/install-linux.sh`). The legacy typo directory `relased/` is permanently prohibited.

### 11.2 Database Query & Bulk Update Engine (`desktop/db.js`)
The desktop worker includes an offline extension engine for querying and synchronizing core tables without raw SQL:
- **`downloadTableDetails(tableName, options)`**: Parameterized read access for allowlisted tables (`orders`, `returns`, `settlements`, `rc_commission`, `rc_fixed_fee`, `rc_collection_fee`, `rc_reverse_shipping`, `rate_card_versions`, `sku_master`, `vb_sku_master`). Table names and columns are validated against `/^[a-zA-Z_][a-zA-Z0-9_]*$/`. Role-gated by `isAuthorizedDesktopRole`.
- **`uploadTableUpdates(tableName, rows, keyColumns)`**: Atomic transactional batch upsert using `ON CONFLICT (...) DO UPDATE SET ...`. Role-gated by `isAuthorizedMutationRole` (`admin`, `operator`). Automatically chunks batch queries to respect PostgreSQL's 65,535 parameter limit.

### 11.3 Cross-Platform Linux Daemon & Systemd Service
For automated execution without a GUI, `released/linux/install-linux.sh` configures:
- Deploys application bundle to `/opt/reconcentral-ratecard/`.
- Sets directory permissions to `0700` and config permissions to `0600`.
- Symlinks `/usr/local/bin/reconcentral-ratecard`.
- Configures and enables `/etc/systemd/system/reconcentral-ratecard.service` running `desktopServer.mjs` on port `3388`.

### 11.4 Comprehensive Technical References
For complete, line-by-line architectural contracts, parameter definitions, and agent playbooks, refer to:
- **[`docs/DESKTOP_WORKER_AND_EXTENSION_SPEC.md`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/docs/DESKTOP_WORKER_AND_EXTENSION_SPEC.md)**: Full technical specification of the Desktop Worker and Database Extension Engine.
- **[`docs/AGENT_HANDOFF_DESKTOP_WORKER.md`](file:///c:/Users/Pawan%20Shukla/Desktop/DashBorad%20Project/docs/AGENT_HANDOFF_DESKTOP_WORKER.md)**: Agent handoff playbook with troubleshooting procedures, extension workflows, and test commands.


