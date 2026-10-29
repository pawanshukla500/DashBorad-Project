import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const desktopDist = path.join(projectRoot, 'desktop', 'dist-release');
const releasedDir = path.join(projectRoot, 'released');
const userDesktopReleased = path.join(os.homedir(), 'Desktop', 'released');

const targetDirs = [releasedDir, userDesktopReleased];
for (const dir of targetDirs) {
  fs.mkdirSync(dir, { recursive: true });
}

const setupExeSource = path.join(desktopDist, 'ReconCentral RateCard Worker Setup 1.0.0.exe');
const portableExeSource = path.join(desktopDist, 'ReconCentral RateCard Worker 1.0.0.exe');

console.log('[Release] Checking source executables in:', desktopDist);
if (!fs.existsSync(setupExeSource)) {
  console.error('[Release] Error: Setup executable not found:', setupExeSource);
  process.exit(1);
}

const linuxScriptSource = path.join(projectRoot, 'released', 'linux', 'install-linux.sh');

function copyDesktopPayloadForLinux(targetLinuxDir) {
  const destDesktopDir = path.join(targetLinuxDir, 'desktop');
  fs.mkdirSync(destDesktopDir, { recursive: true });

  const desktopSrc = path.join(projectRoot, 'desktop');
  const items = [
    'package.json',
    'package-lock.json',
    'main.js',
    'preload.cjs',
    'desktopServer.mjs',
    'worker.js',
    'browserRuntime.js',
    'sessionAccess.js',
    'scrapeResults.js',
    'dbUrlGuard.js',
    'httpAccess.js',
    'portalScraper.js',
    'cookieVault.js',
    'chromeFinder.js',
    'db.js',
    'rateCardService.js',
    'excelExport.js',
    'authValidation.js',
    'ui'
  ];

  for (const item of items) {
    const s = path.join(desktopSrc, item);
    const d = path.join(destDesktopDir, item);
    if (fs.existsSync(s)) {
      const stat = fs.statSync(s);
      if (stat.isDirectory()) {
        fs.cpSync(s, d, { recursive: true });
      } else {
        fs.copyFileSync(s, d);
      }
    }
  }
}

for (const dir of targetDirs) {
  console.log('[Release] Copying installation executables into:', dir);
  fs.copyFileSync(setupExeSource, path.join(dir, 'ReconCentral-RateCard-Worker-Setup.exe'));
  fs.copyFileSync(portableExeSource, path.join(dir, 'ReconCentral-RateCard-Worker-Portable.exe'));

  if (fs.existsSync(linuxScriptSource)) {
    const targetLinuxDir = path.join(dir, 'linux');
    fs.mkdirSync(targetLinuxDir, { recursive: true });
    const targetLinuxScript = path.join(targetLinuxDir, 'install-linux.sh');
    if (path.resolve(linuxScriptSource) !== path.resolve(targetLinuxScript)) {
      fs.copyFileSync(linuxScriptSource, targetLinuxScript);
    }
    copyDesktopPayloadForLinux(targetLinuxDir);
  }
}

// Generate comprehensive INSTALLATION_AND_AUTHORIZATION_GUIDE.md inside released directories
const guideContent = `# ReconCentral RateCard Desktop Center — Installation & Authorization Manual

## 1. Overview
The ReconCentral RateCard Desktop Worker is a standalone, cross-platform PC application built to automate Flipkart & Shopsy fee rate card scraping, brand-wise change detection, and PostgreSQL database synchronization without requiring terminal commands or batch files. Operates on both **Windows** and **Linux**.

## 2. Installation Files in This Folder

| File Name | File Type | Description |
| :--- | :--- | :--- |
| **ReconCentral-RateCard-Worker-Setup.exe** | **Windows NSIS Installer (Recommended)** | Double-click to install the full desktop application to your PC. Automatically creates a Desktop Icon, Start Menu shortcut, and uninstaller. |
| **ReconCentral-RateCard-Worker-Portable.exe** | **Standalone Portable Executable** | Single-file executable that runs immediately without installing to Program Files. Ideal for quick runs, USB drives, or restricted PCs. |
| **linux/install-linux.sh** | **Linux Installer & Systemd Service** | Deploy to Linux desktops or servers. Configures automatic dependencies, symlink in \`/usr/local/bin\`, and background systemd service. |

## 3. Step-by-Step Installation & Authorization Guide (Windows)

### Step 1: Install the Application
1. Double-click \`ReconCentral-RateCard-Worker-Setup.exe\`.
2. The installer will extract and install the application into your local applications directory.
3. A desktop shortcut named **ReconCentral RateCard Worker** will appear on your desktop.

### Step 2: First-Time Login & PC Authorization
1. Launch **ReconCentral RateCard Worker** from your Desktop or Start Menu.
2. If this PC has not been authorized, the **ReconCentral Desktop Authorization** window will appear.
3. Enter your ReconCentral Firebase credentials:
   - **Email**: \`returnorders@vbexports.co.in\` (or your registered admin/operator/analyst email)
   - **Password**: Your ReconCentral password
4. *(Optional)* Click **Advanced Database Connection** to inspect or test the PostgreSQL connection string. Click **Test DB Ping** to verify network connectivity.
5. Click **Sign In & Authorize PC**.
6. The application authenticates via Firebase Auth, verifies your authorization role in the PostgreSQL \`users\` table, and unlocks full operational capabilities.
7. Your authorized session tokens and AES-256-GCM encrypted marketplace session cookies are stored in your local user data directory, so you do not need to log in again on future launches.

### Step 3: Daily Operations
- **Run Extraction**: Click **🚀 Run Extraction** on Dashboard or Live Scraper tab to inspect rate cards.
- **Review & Sync**: Go to **Review & DB Sync** tab to review detected changes against live PostgreSQL records, and click **✓ Commit & Auto-Close in Database** to sync. Commit is enabled only after a successful extraction on the selected channel; generated template previews are read-only and cannot be committed.
- **Excel Report**: Click **📑 Export Excel** or **📂 Open in Microsoft Excel** to inspect the 6-sheet brand-wise workbook.

## 4. Linux Deployment (Debian / Ubuntu / RHEL / Arch)
1. Run the installer script with sudo:
   \`\`\`bash
   sudo bash released/linux/install-linux.sh
   \`\`\`
2. The installer automatically installs Node.js LTS, Chromium, production dependencies, links \`/usr/local/bin/reconcentral-ratecard\`, and enables and starts the background systemd service (\`systemctl enable --now reconcentral-ratecard.service\`).
3. Run interactively or scrape from any terminal:
   \`\`\`bash
   reconcentral-ratecard --help
   reconcentral-ratecard --marketplace=both --auto-sync
   \`\`\`
4. Or launch the web control panel: \`http://localhost:3388\`
5. Check background service status: \`systemctl status reconcentral-ratecard\`

## 5. API Server Database Provisioning (Required Before First Sync)
The worker never ships database credentials — they are provisioned over TLS after Firebase role verification. Configure these environment variables on the ReconCentral API server (Docker / Hostinger deployment) and restart the API service:

| Variable | Purpose |
| :--- | :--- |
| \`DESKTOP_DATABASE_URL\` | Publicly routable PostgreSQL URL handed to verified admin/operator sessions. Container-internal hosts (e.g. \`postgres:5432\`) and reserved-documentation hosts are refused automatically. |
| \`DESKTOP_ANALYST_DATABASE_URL\` | Distinct **read-only** database principal for analyst sign-ins. Analysts never receive writer credentials; without this variable they sign in with no database access. |

After both variables are configured, sign in once inside the worker to provision. The dashboard and the Settings tab then report an honest connection status, and the API server logs which URL class was issued per role.

---

© ReconCentral Enterprise Reconciliation • VB Exports
`;

for (const dir of targetDirs) {
  fs.writeFileSync(path.join(dir, 'INSTALLATION_AND_AUTHORIZATION_GUIDE.md'), guideContent, 'utf8');
}

console.log('[Release] All installation files and documentation successfully prepared!');
