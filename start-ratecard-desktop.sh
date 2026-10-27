#!/usr/bin/env bash
# ======================================================================
# ReconCentral - Flipkart and Shopsy RateCard Desktop Engine (Linux)
# ======================================================================

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$DIR"

echo "======================================================================"
echo "  ⚡ ReconCentral - Flipkart and Shopsy RateCard Desktop Center (Linux)"
echo "======================================================================"
echo ""

# 1. Check Node.js runtime
if ! command -v node >/dev/null 2>&1; then
    echo "❌ Error: Node.js is not found in PATH."
    echo "Please install Node.js (v18+ or v20+) before running."
    exit 1
fi

NODE_VER=$(node -v)
echo "✓ Node.js runtime: $NODE_VER"

# 2. Check for Chrome / Chromium
CHROME_BIN=""
for bin in /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser /snap/bin/chromium; do
    if [ -x "$bin" ]; then
        CHROME_BIN="$bin"
        break
    fi
done

if [ -n "$CHROME_BIN" ]; then
    echo "✓ Chrome/Chromium detected: $CHROME_BIN"
else
    echo "ℹ Note: Google Chrome / Chromium not found in standard paths."
    echo "  Scraper will utilize headless engine or Puppeteer browser."
fi

# 3. Check for GUI Display (X11 / Wayland)
if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; then
    echo "✓ Graphical display detected (X11/Wayland). App window will launch automatically."
else
    echo "ℹ Headless Linux server environment detected (no DISPLAY)."
    echo "  Access the Web Control Center at http://localhost:3388"
fi

echo ""
echo "🚀 Launching Desktop Control Center Server on port 3388..."
echo ""

node desktop/desktopServer.mjs "$@"
