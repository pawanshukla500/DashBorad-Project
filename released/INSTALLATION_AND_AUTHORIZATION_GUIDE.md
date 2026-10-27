# ReconCentral RateCard Desktop Center — Installation & Authorization Manual

## 1. Overview
The ReconCentral RateCard Desktop Worker is a standalone, cross-platform PC application built to automate multi-marketplace fee rate card scraping, brand-wise change detection, and PostgreSQL database synchronization without requiring terminal commands or batch files.

### Supported Marketplace Channels & Vaults:
- **Flipkart & Shopsy**: Flat 0% Shopsy commissions, tiered closing fee (₹0 / ₹10), and return shipping matrix.
- **Myntra (VB)**: Seller ID `10708` (VB Exports) with isolated partner session vault.
- **Myntra (EJ)**: Seller ID `45833` (Ethnic Junction) with isolated partner session vault.
- **Meesho**: Supplier Panel automation with isolated cookie store.
- **Amazon & AJIO**: Integrated via ReconCentral backend account vaults.

## 2. Installation Files in This Folder

| File Name | File Type | Description |
| :--- | :--- | :--- |
| **ReconCentral-RateCard-Worker-Setup.exe** | **Windows NSIS Installer (Recommended)** | Double-click to install the full desktop application to your PC. Automatically creates a Desktop Icon with the official ReconCentral logo, Start Menu shortcut, and uninstaller in Program Files. |
| **ReconCentral-RateCard-Worker-Portable.exe** | **Standalone Portable Executable** | Single-file executable that runs immediately without installing to Program Files. Ideal for quick runs, USB drives, or restricted PCs. |
| **linux/install-linux.sh** | **Linux Auto-Deploy Script** | Complete one-command deployment script for Ubuntu/Debian, Fedora/RHEL, and Arch Linux headless servers with systemd background service. |

## 3. Safe Storage & Program Files Compatibility
When installed to `C:\Program Files\ReconCentral RateCard Worker\`, all writable data (session tokens, AES-256 encrypted marketplace cookies, configurations, and temporary JSON files) are stored exclusively in the OS-standard user data directory:
- **Windows**: `%APPDATA%\ReconCentral RateCard Worker\` (`C:\Users\<User>\AppData\Roaming\ReconCentral RateCard Worker\`)
- **Linux**: `~/.config/reconcentral-ratecard-worker/` or `$XDG_CONFIG_HOME`

This guarantees that the application never encounters `EPERM` or `EACCES` write errors when running from a protected Program Files directory.

## 4. Step-by-Step Installation & Authorization Guide

### Step 1: Install the Application
1. Double-click `ReconCentral-RateCard-Worker-Setup.exe`.
2. The installer will extract and install the application into your local applications directory.
3. A desktop shortcut named **ReconCentral RateCard Worker** with the official brand logo will appear on your desktop.

### Step 2: First-Time Login & PC Authorization
1. Launch **ReconCentral RateCard Worker** from your Desktop or Start Menu.
2. If this PC has not been authorized, the **ReconCentral Desktop Authorization** window will appear.
3. Enter your ReconCentral Firebase credentials:
   - **Email**: `returnorders@vbexports.co.in` (or your registered admin/operator/analyst email)
   - **Password**: Your ReconCentral password
4. *(Optional)* Click **Advanced Connection Settings** to inspect or test the PostgreSQL connection string. Click **Test DB Ping** to verify network connectivity.
5. Click **Sign In & Authorize PC**.
6. The application authenticates via Firebase Auth, verifies your authorization role in the PostgreSQL `users` table, and unlocks full operational capabilities.
7. Your credentials and authorized session are stored securely in your user data directory, so you do not need to log in again on future launches.

### Step 3: Multi-Marketplace 2FA & Operations
- **Switch Channels**: Use the top-right Channel Selector to switch between **Flipkart & Shopsy**, **Myntra (VB - 10708)**, **Myntra (EJ - 45833)**, and **Meesho**.
- **Human 2FA Login**: Click **🔑 Human Login (2FA)** for any channel to open a visible browser window, complete two-factor authentication or captcha manually, and save the session into that channel's dedicated cookie vault.
- **Run Extraction**: Click **⚡ Run Scraper Worker** to scrape active rate cards and fee slabs.
- **Review & Sync**: Go to **Review & DB Sync** tab to review detected changes against live PostgreSQL records, and click **✓ Commit & Auto-Close in Database** to sync.
- **Excel Report**: Click **📑 Export Excel** or **📂 Open in Microsoft Excel** to inspect the 6-sheet brand-wise workbook.

---
© ReconCentral Enterprise Reconciliation • VB Exports

