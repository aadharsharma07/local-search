// Tools that run on the PC against the real index and print to the terminal only. Nothing here
// writes a report: their output contains queries, file names and text.

import { readFileSync, writeFileSync } from "node:fs";
import { normalize } from "node:path";
import type { DB } from "./db/index.ts";
import type { Embedder } from "./embed/index.ts";
import { search, type Trace } from "./search/index.ts";

const key = (p: string) => normalize(p).normalize("NFC");

export interface WhyReport {
  file: { state: string; kind: string; skipReason: string | null; error: string | null } | null;
  content: { extractor: string; chars: number; chunks: number; words: number; contentDate: number | null } | null;
  /** 1-based position in the fused results (searching the top `depth`), null if not retrieved. */
  position: number | null;
  trace: Trace | null;
  /** What the top result scored, for comparison. */
  topScore: number | null;
  score: number | null;
}

/**
 * Why a file did (not) come back for a query: its index state, how much text it has, and where
 * it ranked in each list. For diagnosing misses from the private test set.
 */
export async function why(db: DB, embedder: Embedder | null, q: string, path: string, depth = 200): Promise<WhyReport> {
  const f = db
    .prepare("SELECT state, kind, skip_reason AS skipReason, error, content_hash AS hash FROM files WHERE path = ? AND deleted_at IS NULL")
    .get(key(path)) as { state: string; kind: string; skipReason: string | null; error: string | null; hash: string | null } | undefined;
  const c = f?.hash
    ? (db
        .prepare(
          `SELECT extractor, length(text) AS chars, content_date AS contentDate, text,
                  (SELECT count(*) FROM chunks WHERE content_hash = hash) AS chunks
           FROM contents WHERE hash = ?`,
        )
        .get(f.hash) as { extractor: string; chars: number; contentDate: number | null; text: string; chunks: number } | undefined)
    : undefined;
  const hits = await search(db, embedder, q, { limit: depth, depth, useFeedback: false });
  const i = hits.findIndex((h) => h.paths.some((p) => key(p) === key(path)));
  return {
    file: f ? { state: f.state, kind: f.kind, skipReason: f.skipReason, error: f.error } : null,
    content: c
      ? { extractor: c.extractor, chars: c.chars, chunks: c.chunks, words: (c.text.match(/\p{L}{2,}/gu) ?? []).length, contentDate: c.contentDate }
      : null,
    position: i >= 0 ? i + 1 : null,
    trace: i >= 0 ? hits[i]!.trace : null,
    topScore: hits[0]?.score ?? null,
    score: i >= 0 ? hits[i]!.score : null,
  };
}

export interface Suggestion {
  q: string;
  path: string;
  opens: number;
}

/**
 * Searches whose results were opened, as candidate test set entries: one per (search wording,
 * opened file), most-opened first, leaving out pairs the test set already has.
 */
export function suggestTests(db: DB, existing: { q: string; expected: string[] }[]): Suggestion[] {
  const norm = (q: string) => q.toLowerCase().replace(/\s+/g, " ").trim();
  const have = new Set(existing.flatMap((t) => t.expected.map((e) => `${norm(t.q)}\n${key(e).toLowerCase()}`)));
  const rows = db
    .prepare(
      `SELECT qu.text AS q, f.path FROM feedback fb
       JOIN queries qu ON qu.id = fb.query_id JOIN files f ON f.id = fb.file_id
       WHERE fb.action IN ('open', 'open_folder') AND f.deleted_at IS NULL
       ORDER BY fb.ts DESC, fb.rowid DESC`,
    )
    .all() as { q: string; path: string }[];
  const byPair = new Map<string, Suggestion>(); // first seen = most recent wording
  for (const r of rows) {
    const k = `${norm(r.q)}\n${key(r.path).toLowerCase()}`;
    if (have.has(k)) continue;
    const s = byPair.get(k) ?? { q: r.q.trim(), path: r.path, opens: 0 };
    s.opens++;
    byPair.set(k, s);
  }
  return [...byPair.values()].sort((a, b) => b.opens - a.opens);
}

/** Append accepted suggestions to a test set file (absolute paths), keeping everything else. */
export function appendTests(file: string, add: { q: string; path: string }[]): number {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { queries: { q: string; expected: string[] }[] };
  for (const a of add) raw.queries.push({ q: a.q, expected: [a.path] });
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
  return add.length;
}
