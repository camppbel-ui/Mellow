#!/bin/bash
#
# install-launchd.sh - registers the Ratchet client as a launchd daemon on macOS.
#
# Runs at boot as root (needed for /etc/hosts) and restarts itself if it dies.
#
#   sudo bash install/install-launchd.sh
#
# To remove later:
#   sudo launchctl bootout system/com.ratchet.client
#   sudo rm /Library/LaunchDaemons/com.ratchet.client.plist

set -euo pipefail

LABEL="com.ratchet.client"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash install/install-launchd.sh" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
CLIENT="${ROOT}/ratchet-client.js"

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "Node.js not found on PATH. Install it (brew install node) and retry." >&2
  exit 1
fi

if [[ ! -f "$CLIENT" ]]; then
  echo "Cannot find ratchet-client.js at $CLIENT" >&2
  exit 1
fi

echo "node   : $NODE"
echo "client : $CLIENT"
echo ""

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${CLIENT}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${ROOT}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${ROOT}/launchd-out.log</string>

  <key>StandardErrorPath</key>
  <string>${ROOT}/launchd-err.log</string>
</dict>
</plist>
PLISTEOF

chown root:wheel "$PLIST"
chmod 644 "$PLIST"

launchctl bootout system/"$LABEL" 2>/dev/null || true
launchctl bootstrap system "$PLIST"

echo "Installed and started ${LABEL}."
echo ""
echo "Check it:     sudo launchctl print system/${LABEL} | head -20"
echo "Watch logs:   tail -f ${ROOT}/ratchet-client.log"
echo ""
echo "Leave safety.dryRun = true in config.json until that log looks right."
