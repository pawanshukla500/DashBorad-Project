#!/usr/bin/env bash
# ReconCentral RateCard Desktop & CLI Engine — Linux Installation Script
# Supports Ubuntu/Debian, Fedora/RHEL, and Arch Linux
set -euo pipefail

INSTALL_DIR="/opt/reconcentral-ratecard"
BIN_LINK="/usr/local/bin/reconcentral-ratecard"

echo "=========================================================="
echo " ReconCentral RateCard Scraper & Worker — Linux Installer "
echo "=========================================================="

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: Please run this installer as root (e.g. sudo bash install-linux.sh)" >&2
  exit 1
fi

echo "[1/4] Checking Node.js and Google Chrome..."
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Installing Node.js LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs || yum install -y nodejs || true
fi

if ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
  echo "Google Chrome or Chromium not found. Attempting install..."
  apt-get update && apt-get install -y chromium-browser || apt-get install -y chromium || true
fi

echo "[2/4] Deploying application to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp -r ../desktop/* "$INSTALL_DIR/" || cp -r ./desktop/* "$INSTALL_DIR/" 2>/dev/null || true
cd "$INSTALL_DIR"
if [ ! -d "node_modules" ] || [ ! -f "node_modules/pg/package.json" ]; then
  echo "Installing required production dependencies (pg, dotenv, puppeteer-extra)..."
  npm install --omit=dev
fi

echo "[3/4] Creating symlink in /usr/local/bin..."
cat << 'EOF' > "$BIN_LINK"
#!/usr/bin/env bash
cd /opt/reconcentral-ratecard
exec node desktopServer.mjs "$@"
EOF
chmod +x "$BIN_LINK"

echo "[4/4] Creating systemd service..."
cat << 'EOF' > /etc/systemd/system/reconcentral-ratecard.service
[Unit]
Description=ReconCentral RateCard Automation & Scraper Worker
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/reconcentral-ratecard
ExecStart=/usr/bin/node /opt/reconcentral-ratecard/desktopServer.mjs
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=3388

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
echo ""
echo "Installation Successful!"
echo "To run interactively: reconcentral-ratecard"
echo "To enable background service: systemctl enable --now reconcentral-ratecard"
echo "Web Control Panel: http://localhost:3388"
