/**
 * ClawPulse — Domain Types
 *
 * Breaking news intelligence feed with live threads.
 */

export const VALID_CATEGORIES = [
  "geopolitics",
  "politics",
  "economy",
  "tech",
  "conflict",
  "science",
  "crypto",
  "breaking",
] as const;

export type Category = (typeof VALID_CATEGORIES)[number];

export type ThreadStatus = "pending" | "live" | "rejected" | "closed";

export type ReactionKind = "like" | "dislike";

// --- Row interfaces ---

export interface ThreadRow {
  thread_id: string;
  status: ThreadStatus;
  category: Category;
  headline: string;
  summary: string;
  source_urls: string[];
  submitted_by: string;
  validation_notes: string | null;
  validated_at: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface UpdateRow {
  update_id: string;
  thread_id: string;
  author_address: string;
  body: string;
  source_urls: string[];
  created_at: string;
}

export interface ReactionRow {
  reaction_id: string;
  update_id: string;
  author_address: string;
  kind: ReactionKind;
  created_at: string;
}

export interface OutgoingAction {
  toAddress: string;
  action: string;
  payload: Record<string, unknown>;
  terminal?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  notes: string;
}

export interface AgentStats {
  address: string;
  threads_broken: number;
  updates_contributed: number;
  likes_received: number;
  dislikes_received: number;
}
