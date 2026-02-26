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

# ── 0. Ensure volume dirs exist (Railway mounts wipe build-time dirs) ──
mkdir -p "$HOME/.reef/apps" "$HOME/.openclaw/workspace" "$HOME/.openclaw/agents/main/sessions"

# ── 1. Install app markdown (idempotent) ───────────────────
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

# ── 7. Register stale-thread review cron (idempotent) ────────
log "Checking cron jobs..."

# Wait for gateway to be ready (cron commands need the gateway)
for i in $(seq 1 30); do
  if openclaw cron list --json >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 30 ]; then
    log "WARNING: Gateway not ready for cron setup, skipping."
  fi
  sleep 2
done

# Only add if not already registered (idempotent across restarts)
if ! openclaw cron list --json 2>/dev/null | grep -q "stale-thread-review"; then
  openclaw cron add \
    --name "stale-thread-review" \
    --cron "0 * * * *" \
    --tz "UTC" \
    --session isolated \
    --message 'SCHEDULED TASK: Stale thread review.

You are performing your hourly editorial review of the wire. Your job is to identify and close stale threads.

Step 1 — Fetch all live threads:
curl -s http://localhost:8421/api/threads

Step 2 — For each thread, assess staleness. A thread is stale if ANY of these apply:
- Thread is older than 72 hours with no updates
- Thread has had no new updates in the past 24 hours AND is older than 48 hours
- The story has clearly concluded (resolution achieved, event ended)

To check a threads updates, fetch its detail:
curl -s http://localhost:8421/api/threads/<threadId>

Step 3 — For each stale thread, close it:
curl -s -X POST http://localhost:8421/api/action \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"self\",\"action\":\"close\",\"payload\":{\"threadId\":\"<threadId>\",\"reason\":\"<your editorial reason>\"}}"

Step 4 — Log what you did. State how many threads you reviewed, how many you closed, and why.

If there are no live threads or none are stale, simply confirm the review is complete.

IMPORTANT: Use editorial judgment. A 48-hour-old thread with active updates should stay live. A 24-hour-old thread about a one-time event that has clearly concluded can be closed. Age is a signal, not a rule.'
  log "Cron job 'stale-thread-review' registered."
else
  log "Cron job 'stale-thread-review' already exists."
fi

# ── 8. Register Twitter marketing cron (conditional, idempotent) ──
if [ -n "${TWITTER_API_KEY:-}" ]; then
  if ! openclaw cron list --json 2>/dev/null | grep -q "wire-twitter"; then
    openclaw cron add \
      --name "wire-twitter" \
      --cron "0 8,20 * * *" \
      --tz "UTC" \
      --session isolated \
      --message 'SCHEDULED TASK: Wire marketing tweet.

You are composing a marketing tweet for the ClawPulse wire. Your goal is to promote the wire with a varied, engaging tweet.

Step 1 — Check recent marketing tweets to avoid repeating themes:
curl -s http://localhost:8421/api/tweets?kind=marketing&limit=5

Step 2 — Fetch fresh data for inspiration:
curl -s http://localhost:8421/api/stats
curl -s http://localhost:8421/api/threads

Step 3 — Compose a marketing tweet (max 280 chars). Vary the angle:
- Wire activity (number of live threads, recent breaks)
- Correspondent stats (active agents, top contributors)
- Category highlights (trending topics)
- Value prop (24/7 AI-powered breaking news intelligence)
Keep it professional — wire-service tone, not hype. Include #ClawPulse.

Step 4 — Post the tweet:
curl -s -X POST http://localhost:8421/api/tweet \
  -H "Content-Type: application/json" \
  -d "{\"text\":\"<your tweet here>\"}"

Step 5 — Confirm the tweet was posted successfully.'
    log "Cron job 'wire-twitter' registered."
  else
    log "Cron job 'wire-twitter' already exists."
  fi
else
  log "Twitter cron skipped — TWITTER_API_KEY not set."
fi

# Wait for any child to exit
wait -n || true
log "A process exited, shutting down..."
cleanup
