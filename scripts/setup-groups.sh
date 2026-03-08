#!/bin/bash
# Pre-seed NanoClaw per-group configs for the swarm.
# Run BEFORE starting NanoClaw so containers get swarm MCP tools.
#
# What this does:
# 1. Copies agent-runner source per group and patches allowedTools
# 2. Creates settings.json per group with swarm MCP server config
#
# Usage: ./scripts/setup-groups.sh [/path/to/nanoclaw]

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SWARM_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NANOCLAW_DIR="${1:-/Users/u/nanoclaw}"

if [ ! -d "$NANOCLAW_DIR/container/agent-runner/src" ]; then
  echo "ERROR: NanoClaw not found at $NANOCLAW_DIR"
  echo "Usage: $0 [/path/to/nanoclaw]"
  exit 1
fi

SESSIONS_DIR="$NANOCLAW_DIR/data/sessions"
AGENT_RUNNER_TEMPLATE="$NANOCLAW_DIR/container/agent-runner/src"
SETTINGS_BASE="$SWARM_DIR/config/settings-base.json"

# All swarm group folders
SWARM_GROUPS=(
  slack_swarm-main
  slack_swarm-ingest
  slack_swarm-research
  slack_swarm-coder
  slack_swarm-review
)

# Extract short name from group folder (e.g. slack_swarm-main → main)
group_short() { echo "${1#slack_swarm-}"; }

echo "=== Swarm Group Setup ==="
echo "NanoClaw: $NANOCLAW_DIR"
echo "Swarm:    $SWARM_DIR"
echo ""

for group in "${SWARM_GROUPS[@]}"; do
  echo "[$group]"

  # --- 1. Agent-runner source with allowedTools patch ---
  target="$SESSIONS_DIR/$group/agent-runner-src"
  if [ -d "$target" ]; then
    echo "  agent-runner-src/ exists — checking patch..."
  else
    echo "  Copying agent-runner source..."
    mkdir -p "$target"
    cp "$AGENT_RUNNER_TEMPLATE"/* "$target/" 2>/dev/null || true
    # Also copy subdirectories if any
    for sub in "$AGENT_RUNNER_TEMPLATE"/*/; do
      [ -d "$sub" ] && cp -r "$sub" "$target/"
    done
  fi

  # Apply patch: add mcp__swarm__* to allowedTools if not already present
  index_file="$target/index.ts"
  if [ -f "$index_file" ]; then
    if grep -q "mcp__swarm__" "$index_file" 2>/dev/null; then
      echo "  allowedTools already patched"
    else
      # Patch: add 'mcp__swarm__*' after 'mcp__nanoclaw__*'
      sed "s/'mcp__nanoclaw__\*'/'mcp__nanoclaw__*',\n        'mcp__swarm__*'/" \
        "$index_file" > "$index_file.tmp" && mv "$index_file.tmp" "$index_file"
      echo "  Patched allowedTools with mcp__swarm__*"
    fi
  else
    echo "  WARNING: index.ts not found in agent-runner-src"
  fi

  # --- 2. Settings.json with per-group provider/model/budget config ---
  settings_dir="$SESSIONS_DIR/$group/.claude"
  settings_file="$settings_dir/settings.json"
  mkdir -p "$settings_dir"

  # Select per-group template (falls back to base if group-specific doesn't exist)
  short="$(group_short "$group")"
  GROUP_TEMPLATE="$SWARM_DIR/config/settings-${short}.json"
  if [ ! -f "$GROUP_TEMPLATE" ]; then
    GROUP_TEMPLATE="$SETTINGS_BASE"
  fi

  # Always overwrite settings.json with the latest template
  # (per-group templates include model routing, budget caps, and MCP config)
  echo "  Writing settings.json from settings-${short}.json..."
  cp "$GROUP_TEMPLATE" "$settings_file"

  echo ""
done

echo "=== Group Setup Complete ==="
echo ""
echo "All $((${#SWARM_GROUPS[@]})) groups pre-seeded with:"
echo "  - agent-runner-src/ with mcp__swarm__* in allowedTools"
echo "  - settings.json with per-group provider/model/budget config"
