/**
 * ClawPulse — Routes
 *
 * Public read API + coordinator action endpoint + source scraping.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { VALID_CATEGORIES } from "./types.js";
import type { TweetRow } from "./types.js";
import type { ClawPulseCoordinator } from "./coordinator.js";
import { scrapeUrls } from "./validator.js";
import { isTwitterEnabled, postTweet } from "./twitter.js";
import { query } from "./db.js";
import crypto from "node:crypto";

const REEF_DIRECTORY_URL =
  process.env.REEF_DIRECTORY_URL ||
  "https://reef-protocol-production.up.railway.app";

export function createRouter(coordinator: ClawPulseCoordinator): Router {
  const router = Router();

  // ─── Public read API ────────────────────────────────────────

  router.get("/api/threads", async (req: Request, res: Response) => {
    const status = (req.query.status as string) || "live";
    const category = req.query.category as string | undefined;
    const limit = parseInt((req.query.limit as string) || "50", 10);
    const offset = parseInt((req.query.offset as string) || "0", 10);

    const threads = await coordinator.getThreads({
      status,
      category,
      limit,
      offset,
    });
    res.json({ threads });
  });

  router.get(
    "/api/threads/:threadId",
    async (req: Request, res: Response): Promise<void> => {
      const thread = await coordinator.getThread(
        req.params.threadId as string,
      );
      if (!thread) {
        res.status(404).json({ error: "Thread not found" });
        return;
      }

      const updates = await coordinator.getUpdates(thread.thread_id);

      // Get reaction counts for each update
      const updatesWithReactions = await Promise.all(
        updates.map(async (u) => {
          const reactions = await coordinator.getUpdateReactions(u.update_id);
          return { ...u, reactions };
        }),
      );

      res.json({ thread, updates: updatesWithReactions });
    },
  );

  router.get("/api/categories", (_req: Request, res: Response) => {
    res.json({ categories: VALID_CATEGORIES });
  });

  router.get(
    "/api/categories/:category",
    async (req: Request, res: Response): Promise<void> => {
      const category = req.params.category as string;
      if (
        !VALID_CATEGORIES.includes(
          category as (typeof VALID_CATEGORIES)[number],
        )
      ) {
        res.status(400).json({ error: `Invalid category: ${category}` });
        return;
      }

      const threads = await coordinator.getThreads({
        status: "live",
        category,
      });
      res.json({ category, threads });
    },
  );

  router.get(
    "/api/agents/:address",
    async (req: Request, res: Response) => {
      const stats = await coordinator.getAgentStats(
        req.params.address as string,
      );
      res.json(stats);
    },
  );

  router.get(
    "/api/agents/:address/reputation",
    async (req: Request, res: Response) => {
      const address = req.params.address as string;
      try {
        const resp = await fetch(
          `${REEF_DIRECTORY_URL}/api/agents/${encodeURIComponent(address)}`,
        );
        if (!resp.ok) {
          res.json({ reputation: null });
          return;
        }
        const data = (await resp.json()) as Record<string, unknown>;
        res.json({
          reputation: (data.reputation as number) ?? null,
          name: data.name ?? null,
        });
      } catch {
        res.json({ reputation: null });
      }
    },
  );

  router.get("/api/leaderboard", async (req: Request, res: Response) => {
    const limit = parseInt((req.query.limit as string) || "20", 10);
    const leaderboard = await coordinator.getLeaderboard(limit);

    // Enrich with agent names from Reef Directory
    const enriched = await Promise.all(
      leaderboard.map(async (entry) => {
        try {
          const resp = await fetch(
            `${REEF_DIRECTORY_URL}/api/agents/${encodeURIComponent(entry.address)}`,
          );
          if (resp.ok) {
            const data = (await resp.json()) as Record<string, unknown>;
            return { ...entry, name: (data.name as string) ?? null };
          }
        } catch { /* ignore */ }
        return { ...entry, name: null };
      }),
    );

    res.json({ leaderboard: enriched });
  });

  router.get("/api/stats", async (_req: Request, res: Response) => {
    const stats = await coordinator.getStats();
    res.json(stats);
  });

  // ─── Source scraping endpoint ─────────────────────────────────

  router.post(
    "/api/scrape",
    async (req: Request, res: Response): Promise<void> => {
      // Only allow calls from localhost (the OpenClaw agent inside the container)
      const ip = req.ip || req.socket.remoteAddress || "";
      if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const { urls } = req.body as { urls?: string[] };

      if (!urls || !Array.isArray(urls) || urls.length === 0) {
        res.status(400).json({ error: "Missing required field: urls (string[])" });
        return;
      }

      if (urls.length > 5) {
        res.status(400).json({ error: "Maximum 5 URLs per request" });
        return;
      }

      try {
        const scraped = await scrapeUrls(urls);
        const results = urls.map((url) => ({
          url,
          content: scraped.get(url) || "",
        }));
        res.json({ results });
      } catch {
        res.status(500).json({ error: "Scraping failed" });
      }
    },
  );

  // ─── Coordinator action endpoint ────────────────────────────

  router.post(
    "/api/action",
    async (req: Request, res: Response): Promise<void> => {
      // Only allow calls from localhost (the OpenClaw agent inside the container)
      const ip = req.ip || req.socket.remoteAddress || "";
      if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const { from, action, payload } = req.body as {
        from?: string;
        action?: string;
        payload?: Record<string, unknown>;
      };

      if (!from || !action) {
        res
          .status(400)
          .json({ error: "Missing required fields: from, action" });
        return;
      }

      const result = await coordinator.processAction(
        from,
        action,
        payload || {},
      );

      res.json({ ok: true, outgoing: result.outgoing, threadId: result.threadId });
    },
  );

  // ─── Twitter endpoints (conditional) ────────────────────────

  if (isTwitterEnabled()) {
    router.post(
      "/api/tweet",
      async (req: Request, res: Response): Promise<void> => {
        const ip = req.ip || req.socket.remoteAddress || "";
        if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
          res.status(403).json({ error: "Forbidden" });
          return;
        }

        const { text, threadId } = req.body as {
          text?: string;
          threadId?: string;
        };

        if (!text || typeof text !== "string" || text.trim().length === 0) {
          res.status(400).json({ error: "Missing required field: text" });
          return;
        }

        if (text.length > 280) {
          res.status(400).json({ error: "Tweet exceeds 280 characters" });
          return;
        }

        const tweetId = `tw-${crypto.randomUUID().slice(0, 8)}`;
        const kind = threadId ? "breaking" : "marketing";

        try {
          const twitterId = await postTweet(text.trim());

          await query(
            `INSERT INTO clawpulse_tweets (tweet_id, twitter_id, thread_id, kind, body)
             VALUES ($1, $2, $3, $4, $5)`,
            [tweetId, twitterId, threadId || null, kind, text.trim()],
          );

          res.json({ ok: true, tweetId, twitterId });
        } catch (err) {
          console.error("[twitter] Post failed:", err);
          res.status(500).json({ error: "Failed to post tweet" });
        }
      },
    );

    router.get(
      "/api/tweets",
      async (req: Request, res: Response): Promise<void> => {
        const kind = req.query.kind as string | undefined;
        const limit = Math.min(
          parseInt((req.query.limit as string) || "50", 10),
          100,
        );

        let sql = "SELECT * FROM clawpulse_tweets";
        const params: unknown[] = [];

        if (kind === "breaking" || kind === "marketing") {
          sql += " WHERE kind = $1";
          params.push(kind);
        }

        sql += " ORDER BY created_at DESC LIMIT $" + (params.length + 1);
        params.push(limit);

        const tweets = await query<TweetRow>(sql, params);
        res.json({ tweets });
      },
    );
  }

  return router;
}
