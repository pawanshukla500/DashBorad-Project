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
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js or npm not found. Installing Node.js LTS and npm..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update && apt-get install -y curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs npm
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nodejs npm
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm nodejs npm
  fi
fi

if ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
  echo "Google Chrome or Chromium not found. Attempting install..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update && (apt-get install -y chromium-browser || apt-get install -y chromium || true)
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y chromium || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y chromium || true
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm chromium || true
  fi
fi

TARGET_USER="${SUDO_USER:-$USER}"
TARGET_HOME=$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6 || echo "")
if [ -z "$TARGET_HOME" ]; then
  TARGET_HOME="${HOME:-/root}"
fi

echo "[2/4] Deploying application to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
mkdir -p /etc/reconcentral-ratecard
chmod 700 /etc/reconcentral-ratecard 2>/dev/null || true
chown -R "$TARGET_USER:" /etc/reconcentral-ratecard 2>/dev/null || true
mkdir -p "$TARGET_HOME/.config/reconcentral-ratecard-worker"
chmod 700 "$TARGET_HOME/.config/reconcentral-ratecard-worker" 2>/dev/null || true
chown -R "$TARGET_USER:" "$TARGET_HOME/.config/reconcentral-ratecard-worker" 2>/dev/null || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -d "$SCRIPT_DIR/desktop" ]; then
  cp -r "$SCRIPT_DIR/desktop"/* "$INSTALL_DIR/"
elif [ -d "$SCRIPT_DIR/../../desktop" ]; then
  cp -r "$SCRIPT_DIR/../../desktop"/* "$INSTALL_DIR/"
elif [ -d "./desktop" ]; then
  cp -r ./desktop/* "$INSTALL_DIR/"
else
  echo "Error: Could not locate desktop application package to deploy." >&2
  exit 1
fi
cd "$INSTALL_DIR"
if [ ! -d "node_modules" ] || [ ! -d "node_modules/pg" ] || [ ! -d "node_modules/puppeteer-extra" ] || [ ! -d "node_modules/puppeteer-extra-plugin-stealth" ]; then
  echo "Installing required production dependencies (pg, dotenv, puppeteer-extra)..."
  npm install --omit=dev
fi
chown -R "$TARGET_USER:" "$INSTALL_DIR" 2>/dev/null || true

echo "[3/4] Creating symlink in /usr/local/bin..."
cat << 'EOF' > "$BIN_LINK"
#!/usr/bin/env bash
cd /opt/reconcentral-ratecard

# If CLI options were provided, execute the CLI worker directly
if [ "$#" -gt 0 ]; then
  exec node worker.js "$@"
fi

# Check if desktop server is already running in background on port 3388
if curl -s http://127.0.0.1:3388/api/desktop/health >/dev/null 2>&1; then
  echo "ReconCentral RateCard Worker is already active in background (port 3388)."
  if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; then
    echo "Opening Desktop Web Control Center in browser..."
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "http://127.0.0.1:3388/index.html" >/dev/null 2>&1 &
    fi
  else
    echo "Web Control Panel available at: http://localhost:3388"
  fi
  exit 0
fi

# If background service is not running, launch desktopServer
exec node desktopServer.mjs "$@"
EOF
chmod +x "$BIN_LINK"

echo "[4/4] Creating systemd service..."
cat << EOF > /etc/systemd/system/reconcentral-ratecard.service
[Unit]
Description=ReconCentral RateCard Automation & Scraper Worker
After=network.target

[Service]
Type=simple
User=${TARGET_USER}
WorkingDirectory=/opt/reconcentral-ratecard
ExecStart=/usr/bin/node /opt/reconcentral-ratecard/desktopServer.mjs
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=3388
Environment=HOME=${TARGET_HOME}

[Install]
WantedBy=multi-user.target
EOF

if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
  systemctl daemon-reload
  if systemctl enable --now reconcentral-ratecard.service; then
    echo "✓ Background systemd service enabled and running."
  else
    echo "⚠ Warning: Could not enable systemd service automatically. Start manually with: systemctl enable --now reconcentral-ratecard" >&2
  fi
elif command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable reconcentral-ratecard.service 2>/dev/null || true
  echo "✓ Background systemd service registered."
else
  echo "Note: systemd not active on this environment (container/WSL). Run interactively: reconcentral-ratecard"
fi

echo ""
echo "Installation Successful!"
echo "To run interactively or scrape: reconcentral-ratecard [options]"
echo "Background service status: systemctl status reconcentral-ratecard"
echo "Web Control Panel: http://localhost:3388"
