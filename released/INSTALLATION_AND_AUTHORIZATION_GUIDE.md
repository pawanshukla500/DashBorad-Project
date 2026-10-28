# ReconCentral RateCard Desktop Center — Installation & Authorization Manual

## 1. Overview
The ReconCentral RateCard Desktop Worker is a standalone, cross-platform PC application built to automate Flipkart & Shopsy fee rate card scraping, brand-wise change detection, and PostgreSQL database synchronization without requiring terminal commands or batch files. Operates on both **Windows** and **Linux**.

## 2. Installation Files in This Folder

| File Name | File Type | Description |
| :--- | :--- | :--- |
| **ReconCentral-RateCard-Worker-Setup.exe** | **Windows NSIS Installer (Recommended)** | Double-click to install the full desktop application to your PC. Automatically creates a Desktop Icon, Start Menu shortcut, and uninstaller. |
| **ReconCentral-RateCard-Worker-Portable.exe** | **Standalone Portable Executable** | Single-file executable that runs immediately without installing to Program Files. Ideal for quick runs, USB drives, or restricted PCs. |
| **linux/install-linux.sh** | **Linux Installer & Systemd Service** | Deploy to Linux desktops or servers. Configures automatic dependencies, symlink in `/usr/local/bin`, and background systemd service. |

## 3. Step-by-Step Installation & Authorization Guide (Windows)

### Step 1: Install the Application
1. Double-click `ReconCentral-RateCard-Worker-Setup.exe`.
2. The installer will extract and install the application into your local applications directory.
3. A desktop shortcut named **ReconCentral RateCard Worker** will appear on your desktop.

### Step 2: First-Time Login & PC Authorization
1. Launch **ReconCentral RateCard Worker** from your Desktop or Start Menu.
2. If this PC has not been authorized, the **ReconCentral Desktop Authorization** window will appear.
3. Enter your ReconCentral Firebase credentials:
   - **Email**: `returnorders@vbexports.co.in` (or your registered admin/operator/analyst email)
   - **Password**: Your ReconCentral password
4. *(Optional)* Click **Advanced Database Connection** to inspect or test the PostgreSQL connection string. Click **Test DB Ping** to verify network connectivity.
5. Click **Sign In & Authorize PC**.
6. The application authenticates via Firebase Auth, verifies your authorization role in the PostgreSQL `users` table, and unlocks full operational capabilities.
7. Your authorized session tokens and AES-256-GCM encrypted marketplace session cookies are stored in your local user data directory, so you do not need to log in again on future launches.

#### Database Connection After Login
- If the API server is configured for it, sign-in **auto-provisions the PostgreSQL connection URL** over TLS and the Dashboard **Database Connection** card shows **Connected**.
- If the Dashboard instead shows **DB Offline** or the terminal prints a warning after sign-in, the server did not provision a usable URL. Paste the public PostgreSQL connection string (e.g. `postgresql://user:password@db-host:5432/paymentapp?sslmode=require`) into **Settings → Database Connection URL** and click **Test DB Ping**.
- The app never adopts unreachable URLs: container-internal addresses (such as `postgres:5432` used inside the server's Docker network) are refused, and stale saved ones are discarded automatically.
- **Server operators**: set `DESKTOP_DATABASE_URL` in the API server's `.env` for admin/operator desktop sessions. To enable analyst reads, separately set `DESKTOP_ANALYST_DATABASE_URL` to a publicly routable URL for a PostgreSQL principal with read-only grants. Never reuse the admin/operator URL for analysts. Without the relevant setting, that role will not receive a database URL.

### Step 3: Daily Operations
- **Run Extraction**: Click **🚀 Run Extraction** on Dashboard or Live Scraper tab to inspect rate cards.
- **Review & Sync**: Go to **Review & DB Sync** tab to review detected changes against live PostgreSQL records, and click **✓ Commit & Auto-Close in Database** to sync. Commit is enabled only after a successful extraction on the selected channel; generated template previews are read-only and cannot be committed.
- **Excel Report**: Click **📑 Export Excel** or **📂 Open in Microsoft Excel** to inspect the 6-sheet brand-wise workbook.

## 4. Linux Deployment (Debian / Ubuntu / RHEL / Arch)
1. Run the installer script with sudo:
   ```bash
   sudo bash released/linux/install-linux.sh
   ```
2. The installer automatically installs Node.js LTS, Chromium, production dependencies, links `/usr/local/bin/reconcentral-ratecard`, and enables and starts the background systemd service (`systemctl enable --now reconcentral-ratecard.service`).
3. Run interactively or scrape from any terminal:
   ```bash
   reconcentral-ratecard --help
   reconcentral-ratecard --marketplace=both --auto-sync
   ```
4. Or launch the web control panel: `http://localhost:3388`
5. Check background service status: `systemctl status reconcentral-ratecard`

---
© ReconCentral Enterprise Reconciliation • VB Exports
