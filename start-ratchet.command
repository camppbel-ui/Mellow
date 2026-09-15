#!/bin/bash
# Starts Mellow in this window and opens the dashboard. Close the window, or
# press Control-C, to stop it. No admin needed.
#
#   Mac:    double-click this file.
#   Linux:  bash start-ratchet.command
#
# If a Mac refuses to open it ("unidentified developer"), open Terminal, type
# bash and a space, drag this file into the window, and press Return.

cd "$(dirname "$0")" || exit 1

# An update brought a newer copy of this file: swap it in and run that instead.
if [ -f start-ratchet.command.new ]; then
  mv -f start-ratchet.command.new start-ratchet.command
  chmod +x start-ratchet.command
  exec bash ./start-ratchet.command "$@"
fi

open_url() {
  if command -v open >/dev/null 2>&1; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1
  else echo "Open $1 in your browser."
  fi
}

# A window opened from Finder does not always get the same PATH as Terminal,
# so look in the places Node's installer, Homebrew, Volta and nvm put it.
if ! command -v node >/dev/null 2>&1; then
  for dir in /usr/local/bin /opt/homebrew/bin "$HOME/.volta/bin"; do
    [ -x "$dir/node" ] && PATH="$dir:$PATH"
  done
  # shellcheck disable=SC1091
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Mellow needs Node.js, and it is not installed."
  echo "Get the LTS version from https://nodejs.org, install it, then run this again."
  echo
  open_url "https://nodejs.org/en/download"
  read -r -p "Press Return to close. " _
  exit 1
fi

# Already running? Just open it.
if curl -fsS -m 2 http://127.0.0.1:7777/api/enforcement >/dev/null 2>&1; then
  open_url "http://localhost:7777/"
  exit 0
fi

echo "Starting Mellow. Leave this window open; close it to stop."
( sleep 2; open_url "http://localhost:7777/" ) &
export MELLOW_LAUNCHER=1
while true; do
  node engine/engine.js
  # 75 means an update was installed: start the new version.
  [ $? -eq 75 ] || break
  echo
  echo "Mellow was updated. Starting the new version..."
done
echo
read -r -p "Mellow has stopped. Press Return to close. " _
