# ── Stage 1: Build ──────────────────────────────────────────
FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ── Stage 2: Runtime ───────────────────────────────────────
FROM node:22-slim

# System deps for crawlee (cheerio) and reef/openclaw CLIs
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git procps \
  && rm -rf /var/lib/apt/lists/*

# Install CLIs globally (plugin installed at runtime by entrypoint)
RUN npm install -g openclaw @reef-protocol/client

# Create non-root user home dirs
RUN mkdir -p /home/node/.reef/apps /home/node/.openclaw/workspace \
  && chown -R node:node /home/node

WORKDIR /app

# Production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled JS from build stage
COPY --from=build /app/dist/ dist/

# Static frontend
COPY public/ public/

# App manifest → reef apps directory
COPY app/clawpulse.md /home/node/.reef/apps/clawpulse.md

# Agent workspace files → openclaw workspace
COPY agent/*.md /home/node/.openclaw/workspace/

# Ensure ownership before switching to node
RUN chown -R node:node /home/node

# Entrypoint
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

USER node

EXPOSE 8421

ENTRYPOINT ["./entrypoint.sh"]
