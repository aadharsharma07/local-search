// Learning from use: searches the popup commits are logged with their query vector; opening a
// result is recorded as feedback. Files opened for the same or a similar past search become one
// more ranked list in the fusion (see rankGroups), so search gets better the more it is used.

import type { DB } from "../db/index.ts";
import type { QueryPlan } from "../planner/index.ts";

export const FEEDBACK_ACTIONS = ["open", "open_folder", "none"] as const;
export type FeedbackAction = (typeof FEEDBACK_ACTIONS)[number];

/** Past searches at least this similar (cosine of query vectors) count as "the same search". */
export const OPENED_MIN_SIM = 0.8;
/** Weight of the opened-files list in the fusion: half of a keyword/vector/filename list. */
export const OPENED_WEIGHT = 0.5;
/** Only the most recent opens are considered. */
const OPENED_LOOKBACK = 5000;

const normText = (q: string) => q.toLowerCase().replace(/\s+/g, " ").trim();

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Buffer) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // vectors are unit length
}

export function logQuery(db: DB, q: string, plan: QueryPlan, vec: Float32Array | null, fp: string | null): number {
  const r = db
    .prepare("INSERT INTO queries(text, plan_json, ts, vec, vec_fp) VALUES (?, ?, ?, ?, ?)")
    .run(q, JSON.stringify(plan), Date.now(), vec ? toBlob(vec) : null, vec ? fp : null);
  return Number(r.lastInsertRowid);
}

export interface Feedback {
  queryId: number;
  fileId: number;
  action: FeedbackAction;
  /** 1-based position of the file in the results the user saw. */
  rank?: number | null;
}

/** Record what the user did with a result. Throws on unknown query, file or action. */
export function recordFeedback(db: DB, f: Feedback): void {
  if (!FEEDBACK_ACTIONS.includes(f.action)) throw new Error(`unknown action ${String(f.action)}`);
  if (!Number.isInteger(f.queryId) || !db.prepare("SELECT 1 FROM queries WHERE id = ?").get(f.queryId)) throw new Error("unknown queryId");
  if (!Number.isInteger(f.fileId) || !db.prepare("SELECT 1 FROM files WHERE id = ?").get(f.fileId)) throw new Error("unknown fileId");
  db.prepare("INSERT INTO feedback(query_id, file_id, action, rank, ts) VALUES (?, ?, ?, ?, ?)").run(
    f.queryId,
    f.fileId,
    f.action,
    f.rank ?? null,
    Date.now(),
  );
}

export interface OpenedFile {
  fileId: number;
  /** Content hash, or null for files without extracted text. */
  hash: string | null;
  /** Best similarity of a past search that opened it (1 = same words). */
  sim: number;
  opens: number;
}

/**
 * Live files opened for searches like this one, best first: by similarity of the past search,
 * then how often. One open is enough to appear; repeated opens only break ties, so a single
 * accidental click can't dominate (the list's weight is capped by OPENED_WEIGHT anyway).
 */
export function openedFor(db: DB, q: string, vec: Float32Array | null, fp: string | null): OpenedFile[] {
  const rows = db
    .prepare(
      `SELECT qu.text, qu.vec, qu.vec_fp AS fp, f.id AS fileId, f.content_hash AS hash
       FROM feedback fb
       JOIN queries qu ON qu.id = fb.query_id
       JOIN files f ON f.id = fb.file_id
       WHERE fb.action IN ('open', 'open_folder') AND f.deleted_at IS NULL
       ORDER BY fb.ts DESC LIMIT ?`,
    )
    .all(OPENED_LOOKBACK) as { text: string; vec: Buffer | null; fp: string | null; fileId: number; hash: string | null }[];
  const want = normText(q);
  const byFile = new Map<number, OpenedFile>();
  for (const r of rows) {
    const sim = normText(r.text) === want ? 1 : vec && r.vec && r.fp === fp ? cosine(vec, fromBlob(r.vec)) : 0;
    if (sim < OPENED_MIN_SIM) continue;
    const o = byFile.get(r.fileId) ?? { fileId: r.fileId, hash: r.hash, sim: 0, opens: 0 };
    o.sim = Math.max(o.sim, sim);
    o.opens++;
    byFile.set(r.fileId, o);
  }
  return [...byFile.values()].sort((a, b) => b.sim - a.sim || b.opens - a.opens);
}
