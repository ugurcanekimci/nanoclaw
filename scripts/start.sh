#!/bin/bash
# Swarm PoC — End-to-End Startup Script
#
# This is the single entry point for starting the entire swarm stack.
# It validates the .env, configures NanoClaw groups, starts services,
# and launches NanoClaw.
#
# Prerequisites:
#   - Docker: running
#   - NanoClaw: cloned at /Users/u/nanoclaw with npm install done
#   - .env file with secrets (copy .env.example and fill in values)
#
# Usage: ./scripts/start.sh

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SWARM_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NANOCLAW_DIR="/Users/u/nanoclaw"
VAULT_DIR="/Users/u/Documents/swarm-kb"

echo "=== Swarm PoC Startup ==="
echo "Swarm:    $SWARM_DIR"
echo "NanoClaw: $NANOCLAW_DIR"
echo "Vault:    $VAULT_DIR"
echo ""

# ─── Step 0: Prerequisites ───────────────────────────────────────────

echo "[0/5] Checking prerequisites..."

errors=0

if ! command -v docker &>/dev/null; then
  echo "  ERROR: Docker not found."
  errors=$((errors + 1))
elif ! docker info &>/dev/null 2>&1; then
  echo "  ERROR: Docker not running. Start Docker Desktop first."
  errors=$((errors + 1))
fi

if ! command -v node &>/dev/null; then
  echo "  ERROR: Node.js not found."
  errors=$((errors + 1))
fi

if [ ! -d "$NANOCLAW_DIR/src" ]; then
  echo "  ERROR: NanoClaw not found at $NANOCLAW_DIR"
  errors=$((errors + 1))
fi

if [ ! -f "$NANOCLAW_DIR/.env" ]; then
  echo "  ERROR: No .env file found. Copy .env.example and fill in secrets."
  errors=$((errors + 1))
fi

if [ $errors -gt 0 ]; then
  echo ""
  echo "Fix the above errors and re-run."
  exit 1
fi

echo "  All prerequisites OK"
echo ""

# ─── Step 1: Validate .env ──────────────────────────────────────────

echo "[1/5] Validating .env..."

required_vars=(SLACK_BOT_TOKEN SLACK_APP_TOKEN)
missing=0
for var in "${required_vars[@]}"; do
  if ! grep -q "^${var}=" "$NANOCLAW_DIR/.env"; then
    echo "  MISSING: $var"
    missing=$((missing + 1))
  fi
done

if [ $missing -gt 0 ]; then
  echo "  ERROR: Missing required env vars. Edit $NANOCLAW_DIR/.env"
  exit 1
fi

# Refresh Claude Code OAuth token from macOS Keychain
KEYCHAIN_CREDS=$(security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null || true)
if [ -n "$KEYCHAIN_CREDS" ]; then
  OAUTH_TOKEN=$(echo "$KEYCHAIN_CREDS" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d['claudeAiOauth']['accessToken'])" 2>/dev/null || true)
  if [ -n "$OAUTH_TOKEN" ]; then
    if grep -q "^CLAUDE_CODE_OAUTH_TOKEN=" "$NANOCLAW_DIR/.env"; then
      sed -i '' "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=${OAUTH_TOKEN}|" "$NANOCLAW_DIR/.env"
    else
      echo "CLAUDE_CODE_OAUTH_TOKEN=${OAUTH_TOKEN}" >> "$NANOCLAW_DIR/.env"
    fi
    echo "  OAuth token refreshed from Keychain"
  else
    echo "  WARNING: Could not extract OAuth token from Keychain"
  fi
else
  echo "  WARNING: No Claude Code credentials in Keychain (run: claude auth login)"
fi
echo ""

# Resolve API port from .env before doing the rest of the startup.
PORT_VALUE="$(awk -F= '/^PORT=/{print $2}' "$NANOCLAW_DIR/.env" | tail -1)"
PORT_VALUE="${PORT_VALUE:-3100}"

# ─── Step 2: Mount Allowlist ─────────────────────────────────────────

echo "[2/5] Installing mount allowlist..."

ALLOWLIST_DIR="$HOME/.config/nanoclaw"
mkdir -p "$ALLOWLIST_DIR"
cp "$SWARM_DIR/config/mount-allowlist.json" "$ALLOWLIST_DIR/mount-allowlist.json"
echo "  Installed at $ALLOWLIST_DIR/mount-allowlist.json"
echo ""

# ─── Step 3: Obsidian Vault ──────────────────────────────────────────

echo "[3/5] Ensuring Obsidian vault structure..."

mkdir -p "$VAULT_DIR"/{youtube,x-posts,research,changelogs,agents,_index,_templates}
echo "  Vault directories OK at $VAULT_DIR"
echo ""

# ─── Step 4: Group Setup ─────────────────────────────────────────────

echo "[4/5] Pre-seeding group configs..."

bash "$SWARM_DIR/scripts/setup-groups.sh" "$NANOCLAW_DIR"
echo ""

# ─── Step 5: NanoClaw ────────────────────────────────────────────────

echo "[5/5] Starting NanoClaw..."

# Crawl4AI is on-demand only (docker compose --profile scraping up crawl4ai -d)

if lsof -nP -iTCP:"$PORT_VALUE" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  NOTE: Port $PORT_VALUE is already in use."
  echo "  NanoClaw will skip its embedded Swarm API."
  echo ""
fi
echo ""
echo "═══════════════════════════════════════════════════"
echo "  Swarm stack ready. NanoClaw starting below."
echo "  Send messages in #swarm-main on Slack."
echo "═══════════════════════════════════════════════════"
echo ""

cd "$NANOCLAW_DIR"
exec npm start
