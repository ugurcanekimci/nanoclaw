#!/bin/bash
# Swarm Setup Script
# Configures NanoClaw with 5 agents, Slack integration, and Obsidian vault

set -euo pipefail

NANOCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
SWARM_DIR="/Users/u/swarm"
VAULT_DIR="/Users/u/Documents/swarm-kb"
CONFIG_DIR="$HOME/.config/nanoclaw"

echo "=== Swarm NanoClaw Setup ==="
echo "NanoClaw: $NANOCLAW_DIR"
echo "Swarm API: $SWARM_DIR"
echo "Obsidian Vault: $VAULT_DIR"
echo ""

# 1. Install NanoClaw dependencies
echo "[1/7] Installing NanoClaw dependencies..."
cd "$NANOCLAW_DIR"
npm install

# 2. Copy Slack channel into NanoClaw
echo "[2/7] Installing Slack channel..."
SLACK_SRC="$NANOCLAW_DIR/.claude/skills/add-slack/add/src/channels/slack.ts"
SLACK_DST="$NANOCLAW_DIR/src/channels/slack.ts"
if [ -f "$SLACK_SRC" ] && [ ! -f "$SLACK_DST" ]; then
  cp "$SLACK_SRC" "$SLACK_DST"
  echo "  Copied slack.ts to src/channels/"
fi

# Enable Slack in the channel barrel file
BARREL="$NANOCLAW_DIR/src/channels/index.ts"
if ! grep -q "import.*slack" "$BARREL" 2>/dev/null; then
  # Add import for slack channel
  echo "import './slack.js';" >> "$BARREL"
  echo "  Added Slack import to channels/index.ts"
fi

# 3. Add @slack/bolt dependency
echo "[3/7] Adding Slack dependencies..."
cd "$NANOCLAW_DIR"
npm install @slack/bolt @slack/types 2>/dev/null || echo "  (npm install may need manual run)"

# 4. Create mount allowlist
echo "[4/7] Configuring mount security..."
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_DIR/mount-allowlist.json" << 'MOUNT_EOF'
{
  "allowedRoots": [
    {
      "path": "/Users/u/Documents/swarm-kb",
      "allowReadWrite": true,
      "description": "Obsidian knowledge base vault (shared by all agents)"
    },
    {
      "path": "/Users/u/swarm",
      "allowReadWrite": true,
      "description": "Swarm API project (coder agent needs write, review gets read-only)"
    }
  ],
  "blockedPatterns": [
    ".ssh", ".gnupg", ".aws", ".docker", "credentials",
    ".env", "*.pem", "*.key", "node_modules"
  ],
  "nonMainReadOnly": false
}
MOUNT_EOF
echo "  Mount allowlist: $CONFIG_DIR/mount-allowlist.json"

# 5. Create .env template (if not exists)
echo "[5/7] Checking .env configuration..."
ENV_FILE="$NANOCLAW_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" << 'ENV_EOF'
# NanoClaw Swarm Configuration

# Assistant identity
ASSISTANT_NAME=Swarm

# Slack credentials (required)
# Create a Slack app at https://api.slack.com/apps
# Enable Socket Mode, add bot scopes: chat:write, channels:history, channels:read, users:read
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token

# Claude API (passed to containers via stdin, never stored in files)
ANTHROPIC_API_KEY=sk-ant-your-key

# Container settings
MAX_CONCURRENT_CONTAINERS=5
IDLE_TIMEOUT=1800000
CONTAINER_TIMEOUT=1800000

# Timezone
TZ=America/Los_Angeles
ENV_EOF
  echo "  Created .env template — EDIT THIS with your API keys!"
else
  echo "  .env already exists"
fi

# 6. Build NanoClaw
echo "[6/7] Building NanoClaw..."
cd "$NANOCLAW_DIR"
npm run build 2>/dev/null || echo "  (build may need manual run after ts fixes)"

# 7. Build container image
echo "[7/7] Building container image..."
cd "$NANOCLAW_DIR"
if command -v docker &>/dev/null; then
  docker build -t nanoclaw-agent:latest container/ 2>/dev/null || echo "  (container build may need Docker running)"
else
  echo "  Docker not available — container build skipped"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit $ENV_FILE with your Slack and Anthropic API keys"
echo "  2. Create Slack channels: #swarm-main, #swarm-ingest, #swarm-research, #swarm-coder, #swarm-review"
echo "  3. Invite the Slack bot to all channels"
echo "  4. Start NanoClaw: cd $NANOCLAW_DIR && npm start"
echo "  5. In #swarm-main, tell @Swarm to register the other channels"
echo "  6. Start the Swarm API: cd $SWARM_DIR && npm run dev"
echo ""
echo "Registration commands (run in #swarm-main after starting):"
echo "  @Swarm register #swarm-ingest as the ingest agent"
echo "  @Swarm register #swarm-research as the research agent"
echo "  @Swarm register #swarm-coder as the coder agent"
echo "  @Swarm register #swarm-review as the review agent"
