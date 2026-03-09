#!/bin/bash
# Refresh OAuth token in NanoClaw .env — called before node starts.
set -euo pipefail

ENV_FILE="/Users/u/nanoclaw/.env"

CREDS_JSON=$(security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null) || exit 1
FRESH_TOKEN=$(echo "$CREDS_JSON" | /opt/homebrew/bin/python3 -c "import sys,json; print(json.loads(sys.stdin.read())['claudeAiOauth']['accessToken'])" 2>/dev/null) || exit 1

if grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" 2>/dev/null; then
  sed -i '' "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=${FRESH_TOKEN}|" "$ENV_FILE"
else
  echo "CLAUDE_CODE_OAUTH_TOKEN=${FRESH_TOKEN}" >> "$ENV_FILE"
fi
