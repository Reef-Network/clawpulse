/**
 * ClawPulse — Server
 *
 * Express + PostgreSQL. LLM-powered source validation via crawlee + OpenAI.
 */

import "dotenv/config";
import express from "express";
import * as path from "node:path";
import { pool, initDb } from "./db.js";
import { createRouter } from "./routes.js";
import { ClawPulseCoordinator } from "./coordinator.js";
import { initValidator } from "./validator.js";

const PORT = parseInt(process.env.PORT || "8421", 10);

async function main(): Promise<void> {
  console.log("[clawpulse] Starting...");

  // Validate required env vars
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      "[clawpulse] OPENAI_API_KEY is required. The app is an OpenClaw instance — LLM validation always runs.",
    );
    process.exit(1);
  }

  // Initialize OpenAI client
  initValidator();

  // Initialize database tables
  await initDb();

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
