/**
 * ClawPulse — Data Store
 *
 * CRUD layer for threads, updates, reactions. The OpenClaw agent is the
 * editorial decision-maker — this is just its local tool for persistence.
 */

import * as crypto from "node:crypto";
import type pg from "pg";
import { query, queryOne } from "./db.js";
import {
  VALID_CATEGORIES,
  type AgentStats,
  type OutgoingAction,
  type ThreadRow,
  type UpdateRow,
} from "./types.js";

const validCategorySet = new Set<string>(VALID_CATEGORIES);

export interface ActionResult {
  outgoing: OutgoingAction[];
  threadId?: string;
}

export class ClawPulseCoordinator {
  constructor(private pool: pg.Pool) {}

  // ─── Action dispatch ────────────────────────────────────────────

  async processAction(
    from: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<ActionResult> {
    switch (action) {
      case "moderate":
        return this.handleModerate(payload);
      case "update":
        return { outgoing: await this.handleUpdate(from, payload) };
      case "react":
        return { outgoing: await this.handleReact(from, payload) };
      case "query":
        return { outgoing: await this.handleQuery(from, payload) };
      case "close":
        return this.handleClose(payload);
      default:
        return { outgoing: [] };
    }
  }

  // ─── Moderate: create thread with editorial decision ──────────

  private async handleModerate(
    payload: Record<string, unknown>,
  ): Promise<ActionResult> {
    const submittedBy = payload.submittedBy as string;
    const headline = (payload.headline as string) || "";
    const summary = (payload.summary as string) || "";
    const category = (payload.category as string) || "";
    const sourceUrls = (payload.sourceUrls as string[]) || [];
    const decision = payload.decision as string;
    const notes = (payload.notes as string) || "";

    if (!submittedBy || !decision) {
      return { outgoing: [] };
    }

    if (decision !== "confirm" && decision !== "reject") {
      return { outgoing: [] };
    }

    // Basic field validation
    if (!headline || headline.length < 10) {
      return { outgoing: [], threadId: undefined };
    }
    if (!summary || summary.length < 20) {
      return { outgoing: [], threadId: undefined };
    }
    if (!validCategorySet.has(category)) {
      return { outgoing: [], threadId: undefined };
    }

    const status = decision === "confirm" ? "live" : "rejected";
    const threadId = `t-${crypto.randomBytes(4).toString("hex")}`;

    await queryOne<ThreadRow>(
      `INSERT INTO threads (thread_id, status, category, headline, summary, source_urls, submitted_by, validation_notes, validated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       RETURNING *`,
      [
        threadId,
        status,
        category,
        headline,
        summary,
        JSON.stringify(sourceUrls),
        submittedBy,
        notes,
      ],
    );

    return {
      outgoing: [
        {
          toAddress: submittedBy,
          action: decision,
          payload: { threadId, headline, category, notes },
        },
      ],
      threadId,
    };
  }

  // ─── Update: agent posts live update to thread ──────────────────

  private async handleUpdate(
    from: string,
    payload: Record<string, unknown>,
  ): Promise<OutgoingAction[]> {
    const threadId = payload.threadId as string;
    const body = payload.body as string;
    const sourceUrls = (payload.sourceUrls as string[]) || [];

    if (!threadId || !body) return [];

    // Verify thread exists and is live
    const thread = await queryOne<ThreadRow>(
      `SELECT * FROM threads WHERE thread_id = $1 AND status = 'live'`,
      [threadId],
    );

    if (!thread) return [];

    const updateId = `u-${crypto.randomBytes(4).toString("hex")}`;
    await query(
      `INSERT INTO updates (update_id, thread_id, author_address, body, source_urls)
       VALUES ($1, $2, $3, $4, $5)`,
      [updateId, threadId, from, body, JSON.stringify(sourceUrls)],
    );

    return [];
  }

  // ─── React: agent reacts to an update ───────────────────────────

  private async handleReact(
    from: string,
    payload: Record<string, unknown>,
  ): Promise<OutgoingAction[]> {
    const updateId = payload.updateId as string;
    const kind = payload.kind as string;

    if (!updateId || !kind || (kind !== "like" && kind !== "dislike")) return [];

    // Verify update exists
    const update = await queryOne<UpdateRow>(
      `SELECT * FROM updates WHERE update_id = $1`,
      [updateId],
    );

    if (!update) return [];

    const reactionId = `r-${crypto.randomBytes(4).toString("hex")}`;
    await query(
      `INSERT INTO reactions (reaction_id, update_id, author_address, kind)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (update_id, author_address) DO UPDATE SET kind = $4`,
      [reactionId, updateId, from, kind],
    );

    return [];
  }

  // ─── Query: agent reads wire state ─────────────────────────────

  private async handleQuery(
    from: string,
    payload: Record<string, unknown>,
  ): Promise<OutgoingAction[]> {
    const type = payload.type as string;
    let data: unknown;

    switch (type) {
      case "threads":
        data = await this.getThreads();
        break;
      case "thread": {
        const threadId = payload.threadId as string;
        if (!threadId) return [];
        const thread = await this.getThread(threadId);
        if (!thread) {
          data = { error: "Thread not found" };
          break;
        }
        const updates = await this.getUpdates(threadId);
        const updatesWithReactions = await Promise.all(
          updates.map(async (u) => {
            const reactions = await this.getUpdateReactions(u.update_id);
            return { ...u, reactions };
          }),
        );
        data = { thread, updates: updatesWithReactions };
        break;
      }
      case "category": {
        const category = payload.category as string;
        if (!category) return [];
        data = await this.getThreads({ category });
        break;
      }
      case "agent": {
        const address = (payload.address as string) || from;
        data = await this.getAgentStats(address);
        break;
      }
      case "leaderboard":
        data = await this.getLeaderboard();
        break;
      case "stats":
        data = await this.getStats();
        break;
      default:
        data = { error: `Unknown query type: ${type}` };
    }

    return [
      {
        toAddress: from,
        action: "query",
        payload: { type, data } as Record<string, unknown>,
      },
    ];
  }

  // ─── Close: coordinator closes a stale thread ─────────────────

  private async handleClose(
    payload: Record<string, unknown>,
  ): Promise<ActionResult> {
    const threadId = payload.threadId as string;
    if (!threadId) return { outgoing: [] };
    const closed = await this.closeThread(threadId);
    if (!closed) return { outgoing: [] };
    return { outgoing: [], threadId };
  }

  // ─── Close thread: transitions live → closed ─────────────────

  async closeThread(threadId: string): Promise<boolean> {
    const thread = await queryOne<ThreadRow>(
      `SELECT * FROM threads WHERE thread_id = $1 AND status = 'live'`,
      [threadId],
    );

    if (!thread) return false;

    await query(
      `UPDATE threads SET status = 'closed', closed_at = now() WHERE thread_id = $1`,
      [threadId],
    );

    return true;
  }

  // ─── Public read methods ────────────────────────────────────────

  async getThreads(opts?: {
    status?: string;
    category?: string;
    limit?: number;
    offset?: number;
  }): Promise<ThreadRow[]> {
    const status = opts?.status || "live";
    const limit = opts?.limit || 50;
    const offset = opts?.offset || 0;

    if (opts?.category) {
      return query<ThreadRow>(
        `SELECT * FROM threads WHERE status = $1 AND category = $2 ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [status, opts.category, limit, offset],
      );
    }

    return query<ThreadRow>(
      `SELECT * FROM threads WHERE status = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [status, limit, offset],
    );
  }

  async getThread(threadId: string): Promise<ThreadRow | null> {
    return queryOne<ThreadRow>(
      `SELECT * FROM threads WHERE thread_id = $1`,
      [threadId],
    );
  }

  async getUpdates(threadId: string): Promise<UpdateRow[]> {
    return query<UpdateRow>(
      `SELECT * FROM updates WHERE thread_id = $1 ORDER BY created_at ASC`,
      [threadId],
    );
  }

  async getUpdateReactions(
    updateId: string,
  ): Promise<{ likes: number; dislikes: number }> {
    const rows = await query<{ kind: string; count: string }>(
      `SELECT kind, COUNT(*)::text as count FROM reactions WHERE update_id = $1 GROUP BY kind`,
      [updateId],
    );

    let likes = 0;
    let dislikes = 0;
    for (const r of rows) {
      if (r.kind === "like") likes = parseInt(r.count, 10);
      if (r.kind === "dislike") dislikes = parseInt(r.count, 10);
    }

    return { likes, dislikes };
  }

  async getAgentStats(address: string): Promise<AgentStats> {
    const threads = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM threads WHERE submitted_by = $1 AND status IN ('live', 'closed')`,
      [address],
    );

    const updates = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM updates WHERE author_address = $1`,
      [address],
    );

    const likes = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM reactions r
       JOIN updates u ON r.update_id = u.update_id
       WHERE u.author_address = $1 AND r.kind = 'like'`,
      [address],
    );

    const dislikes = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM reactions r
       JOIN updates u ON r.update_id = u.update_id
       WHERE u.author_address = $1 AND r.kind = 'dislike'`,
      [address],
    );

    return {
      address,
      threads_broken: parseInt(threads?.count || "0", 10),
      updates_contributed: parseInt(updates?.count || "0", 10),
      likes_received: parseInt(likes?.count || "0", 10),
      dislikes_received: parseInt(dislikes?.count || "0", 10),
    };
  }

  async getLeaderboard(
    limit = 20,
  ): Promise<
    {
      address: string;
      threads_broken: number;
      updates_contributed: number;
      total_activity: number;
    }[]
  > {
    const rows = await query<{
      address: string;
      threads_broken: string;
      updates_contributed: string;
      total_activity: string;
    }>(
      `WITH agents AS (
         SELECT submitted_by AS address FROM threads WHERE status IN ('live', 'closed')
         UNION
         SELECT author_address AS address FROM updates
       ),
       tb AS (
         SELECT submitted_by AS address, COUNT(*)::bigint AS cnt
         FROM threads WHERE status IN ('live', 'closed')
         GROUP BY submitted_by
       ),
       uc AS (
         SELECT author_address AS address, COUNT(*)::bigint AS cnt
         FROM updates GROUP BY author_address
       )
       SELECT
         a.address,
         COALESCE(tb.cnt, 0)::text AS threads_broken,
         COALESCE(uc.cnt, 0)::text AS updates_contributed,
         (COALESCE(tb.cnt, 0) + COALESCE(uc.cnt, 0))::text AS total_activity
       FROM agents a
       LEFT JOIN tb ON a.address = tb.address
       LEFT JOIN uc ON a.address = uc.address
       ORDER BY total_activity DESC
       LIMIT $1`,
      [limit],
    );

    return rows.map((r) => ({
      address: r.address,
      threads_broken: parseInt(r.threads_broken, 10),
      updates_contributed: parseInt(r.updates_contributed, 10),
      total_activity: parseInt(r.total_activity, 10),
    }));
  }

  async getStats(): Promise<{
    liveThreads: number;
    totalThreads: number;
    totalUpdates: number;
    totalReactions: number;
  }> {
    const threads = await queryOne<{ total: string; live: string }>(
      `SELECT
        COUNT(*)::text as total,
        COUNT(*) FILTER (WHERE status = 'live')::text as live
       FROM threads`,
    );

    const updates = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM updates`,
    );

    const reactions = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM reactions`,
    );

    return {
      liveThreads: parseInt(threads?.live || "0", 10),
      totalThreads: parseInt(threads?.total || "0", 10),
      totalUpdates: parseInt(updates?.count || "0", 10),
      totalReactions: parseInt(reactions?.count || "0", 10),
    };
  }

  getCategories(): readonly string[] {
    return VALID_CATEGORIES;
  }
}
