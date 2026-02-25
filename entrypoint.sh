#!/usr/bin/env bash
set -euo pipefail

# ── Helpers ─────────────────────────────────────────────────
log() { echo "[entrypoint] $*"; }

# Track child PIDs for cleanup
PIDS=()

cleanup() {
  log "Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait
  log "All processes stopped."
  exit 0
}

trap cleanup SIGTERM SIGINT

# ── 1. Install app markdown (idempotent) ───────────────────
mkdir -p "$HOME/.reef/apps"
cp -f /app/app/clawpulse.md "$HOME/.reef/apps/clawpulse.md" 2>/dev/null || true
log "App manifest installed."

# ── 2. Generate reef identity if missing ───────────────────
if [ ! -f "$HOME/.reef/identity.json" ]; then
  log "Generating reef identity..."
  reef identity --generate
  log "Identity created."
else
  log "Reef identity exists."
fi

# ── 3. Initialize OpenClaw if needed ─────────────────────────
if [ ! -f "$HOME/.openclaw/openclaw.json" ]; then
  log "Running openclaw onboard..."
  openclaw onboard \
    --mode local \
    --non-interactive \
    --accept-risk \
    --auth-choice openai-api-key \
    --openai-api-key "$OPENAI_API_KEY" \
    --skip-daemon \
    --skip-skills \
    --skip-channels \
    --skip-ui \
    --skip-health
  log "OpenClaw onboard complete."
fi

# Install reef plugin if missing
if [ ! -d "$HOME/.openclaw/extensions/reef-openclaw" ]; then
  log "Installing reef-openclaw plugin..."
  openclaw plugins install @reef-protocol/reef-openclaw
  log "Reef plugin installed."
fi

# Ensure reef channel + elevated tools are in config (idempotent)
log "Ensuring reef channel config..."
node -e "
  const fs = require('fs');
  const p = process.env.HOME + '/.openclaw/openclaw.json';
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  cfg.plugins = cfg.plugins || {};
  cfg.plugins.entries = cfg.plugins.entries || {};
  cfg.plugins.entries['reef-openclaw'] = { enabled: true };
  cfg.channels = cfg.channels || {};
  cfg.channels.reef = {
    accounts: { default: { enabled: true, configDir: process.env.HOME + '/.reef' } },
    dmPolicy: 'open',
    allowFrom: ['*']
  };
  cfg.tools = cfg.tools || {};
  cfg.tools.exec = { host: 'gateway', security: 'full', ask: 'off' };
  cfg.tools.elevated = { enabled: true, allowFrom: { reef: ['*'] } };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
"
log "OpenClaw ready."

# ── 4. Start Express server ────────────────────────────────
log "Starting Express server..."
node dist/server.js &
PIDS+=($!)

# Wait for Express to be ready
log "Waiting for Express health check..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:${PORT:-8421}/api/stats > /dev/null 2>&1; then
    log "Express is ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    log "ERROR: Express did not start within 30s."
    exit 1
  fi
  sleep 1
done

# ── 5. Start reef daemon ───────────────────────────────────
log "Starting reef daemon..."
reef start \
  --name "ClawPulse" \
  --bio "Live breaking news intelligence wire coordinator" &
PIDS+=($!)
log "Reef daemon started."

# Give reef a moment to connect to XMTP
sleep 3

# ── 6. Start OpenClaw gateway (foreground) ─────────────────
log "Starting OpenClaw gateway..."
openclaw gateway run &
PIDS+=($!)
log "All processes running."

# Wait for any child to exit
wait -n || true
log "A process exited, shutting down..."
cleanup
