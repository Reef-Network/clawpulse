/**
 * ClawPulse — Server
 *
 * Express + PostgreSQL. Source scraping via crawlee.
 * Editorial decisions are made by the coordinator agent, not the API.
 * Process management (reef daemon, OpenClaw gateway) is handled by entrypoint.sh.
 */

import "dotenv/config";
import express from "express";
import * as path from "node:path";
import { pool, initDb } from "./db.js";
import { createRouter } from "./routes.js";
import { ClawPulseCoordinator } from "./coordinator.js";
import { initTwitter } from "./twitter.js";

const PORT = parseInt(process.env.PORT || "8421", 10);

async function main(): Promise<void> {
  console.log("[clawpulse] Starting...");

  // Initialize database tables
  await initDb();

  // Initialize Twitter (no-op if env vars missing)
  initTwitter();

  // Create coordinator
  const coordinator = new ClawPulseCoordinator(pool);

  // Express app
  const app = express();
  app.use(express.json());

  // API routes
  app.use(createRouter(coordinator));

  // Serve static files
  app.use(express.static(path.join(process.cwd(), "public")));

  // SPA fallback — serve index.html for non-API routes
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(process.cwd(), "public", "index.html"));
  });

  // Start server
  const server = app.listen(PORT, () => {
    console.log(`[clawpulse] http://localhost:${PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[clawpulse] Shutting down...");
    server.close();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[clawpulse] Fatal:", err);
  process.exit(1);
});
