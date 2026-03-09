#!/bin/bash
# Deploy NanoClaw: build from source then restart via launchd.
# Run this after merging a PR to main. Requires launchd plist to be loaded.
set -e
cd "$(dirname "$0")/.."

echo "[deploy] Building NanoClaw..."
npm run build

echo "[deploy] Restarting NanoClaw via launchd..."
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"

echo "[deploy] Done."
