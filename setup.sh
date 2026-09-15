#!/bin/bash
#
# setup.sh - one-command setup for the Mac (client machine).
#
#   sudo bash setup.sh
#
# Checks Node, offers Tailscale, sets the engine URL, runs tests and a dry run,
# then optionally installs the launchd daemon. Does NOT turn enforcement on.

set -uo pipefail

say()  { printf '%s\n' "$1"; }
step() { printf '\n[%s] %s\n' "$1" "$2"; }

# Replace only the server.url value. Round-tripping the file through
# JSON.parse/stringify would throw away every comment in it, and config.json is
# the one file that is meant to be read by a human.
set_engine_url() {
  RATCHET_CFG="$1" RATCHET_URL="$2" node -e '
    const fs = require("fs");
    const file = process.env.RATCHET_CFG;
    const url = process.env.RATCHET_URL;
    const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    let done = false;
    const out = text.replace(/("url"\s*:\s*")[^"]*(")/, (m, a, b) => {
      done = true;
      return a + url.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + b;
    });
    if (!done) { console.error("Could not find server.url in " + file); process.exit(1); }
    fs.writeFileSync(file, out);
  '
}

read_engine_url() {
  RATCHET_CFG="$1" node -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync(process.env.RATCHET_CFG, "utf8").replace(/^﻿/, ""));
    console.log(c.server.url);
  '
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
say "Mellow setup - working in $ROOT"

# --- 1. Node ----------------------------------------------------------------
step 1 "Node.js"
if command -v node >/dev/null 2>&1; then
  say "  found: $(node --version)"
else
  say "  not found."
  if command -v brew >/dev/null 2>&1; then
    read -r -p "  Install with Homebrew? (y/n) " a
    [[ "$a" == "y" ]] && brew install node
  else
    say "  Install Node LTS from nodejs.org, then re-run this script."
    exit 1
  fi
fi

# --- 2. Tailscale -----------------------------------------------------------
step 2 "Tailscale"
if command -v tailscale >/dev/null 2>&1; then
  say "  already installed."
else
  say "  Not installed. Get it from tailscale.com/download or the App Store."
  say "  Signing in needs your browser and cannot be scripted."
fi

# --- 3. Config --------------------------------------------------------------
step 3 "Engine URL"
CFG="$ROOT/config.json"
[[ -f "$CFG" ]] || { say "  config.json missing!"; exit 1; }

CURRENT=$(read_engine_url "$CFG")
say "  current: $CURRENT"
say "  On the Mac this is the PC's Tailscale name, e.g."
say "    http://your-pc:7777/api/enforcement"
read -r -p "  Engine URL (Enter to keep): " NEWURL
if [[ -n "${NEWURL:-}" ]]; then
  set_engine_url "$CFG" "$NEWURL" && say "  saved."
fi

# --- 4. Tests ---------------------------------------------------------------
step 4 "Test suite"
node test-logic.js || { say "  Tests failed - stopping."; exit 1; }

# --- 5. Dry run -------------------------------------------------------------
step 5 "Dry run"
# The mock forces the worst case, so one cycle shows the whole block list.
node mock-server.js shield_all >/dev/null 2>&1 &
MOCK=$!
sleep 2
SAVED=$(read_engine_url "$CFG")
set_engine_url "$CFG" "http://localhost:7777/api/enforcement"
node ratchet-client.js --once || true
kill "$MOCK" 2>/dev/null || true
set_engine_url "$CFG" "$SAVED"
say ""
say "  Read the DRY lines above - those are the apps it would quit."

# --- 6. launchd -------------------------------------------------------------
step 6 "Run at boot"
read -r -p "  Install the launchd daemon now? (y/n) " a
if [[ "$a" == "y" ]]; then
  sudo bash install/install-launchd.sh
else
  say "  skipped."
fi

printf '\nDone. Enforcement is still OFF (safety.dryRun = true).\n'
