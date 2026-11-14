import { basename } from "node:path";
import type { DB } from "../db/index.ts";
import type { Embedder } from "../embed/index.ts";

export const RRF_K = 60;

export interface SearchOptions {
  limit?: number;
  /** Candidates pulled from each retriever before fusion. */
  depth?: number;
}

export interface Trace {
  keyword?: { rank: number; bm25: number };
  vector?: { rank: number; distance: number };
  filename?: { rank: number; matched: number };
  bonus: number;
}

export interface SearchHit {
  /** Every live path holding this content (duplicates share one hit). First is the primary. */
  paths: string[];
  score: number;
  snippet: string;
  page: number | null;
  trace: Trace;
}

const terms = (q: string) => [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];

/** FTS5 query: every term as a prefix match, OR-ed, so partial matches still rank. */
export function ftsQuery(q: string): string | null {
  const t = terms(q);
  return t.length ? t.map((x) => `"${x.replace(/"/g, "")}"*`).join(" OR ") : null;
}

/** A window of the chunk around the first query term, for display. */
export function snippetFor(text: string, q: string, width = 220): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms(q)) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, (at < 0 ? 0 : at) - Math.floor(width / 3));
  const s = text.slice(start, start + width).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + s + (start + width < text.length ? "…" : "");
}

interface Group {
  key: string; // content hash, or f:<id> for files without content
  chunkId: number | null;
  score: number;
  trace: Trace;
}

/**
 * Hybrid search: keyword (FTS5/BM25), vector (sqlite-vec) and filename lists, fused with
 * reciprocal rank fusion plus a small bonus for top ranks, grouped per content so duplicates
 * appear once. Facets, expansion and reranking plug in on top of this in Sprint 2.
 */
export async function search(db: DB, embedder: Embedder | null, q: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const limit = opts.limit ?? 10;
  const depth = opts.depth ?? 100;
  const groups = new Map<string, Group>();
  const touch = (key: string, chunkId: number | null): Group => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, chunkId, score: 0, trace: { bonus: 0 } }));
    if (g.chunkId === null && chunkId !== null) g.chunkId = chunkId;
    return g;
  };
  const contribute = (g: Group, rank: number, weight = 1) => {
    g.score += weight / (RRF_K + rank + 1);
    const bonus = rank === 0 ? 0.05 : rank <= 2 ? 0.02 : 0;
    if (bonus > g.trace.bonus) {
      g.score += bonus - g.trace.bonus;
      g.trace.bonus = bonus;
    }
  };
  const liveContent = db.prepare("SELECT 1 FROM files WHERE content_hash = ? AND deleted_at IS NULL LIMIT 1");

  // Keyword list: rank chunks, keep each content's best chunk.
  const fq = ftsQuery(q);
  if (fq) {
    const rows = db
      .prepare(
        `SELECT c.id, c.content_hash AS hash, bm25(chunks_fts) AS s
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ? ORDER BY s LIMIT ?`,
      )
      .all(fq, depth * 3) as { id: number; hash: string; s: number }[];
    let rank = 0;
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.hash) || !liveContent.get(r.hash)) continue;
      seen.add(r.hash);
      const g = touch(r.hash, r.id);
      g.trace.keyword = { rank: rank + 1, bm25: Math.round(r.s * 1000) / 1000 };
      contribute(g, rank++);
      if (rank >= depth) break;
    }
  }

  // Vector list.
  const hasVec = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chunk_vecs'").get();
  if (embedder && hasVec) {
    const qv = await embedder.embedQuery(q);
    // KNN on the vec0 table alone (sqlite-vec needs the MATCH and k constraints on it directly),
    // then look up each chunk's content.
    const knn = db
      .prepare("SELECT chunk_id AS id, distance AS d FROM chunk_vecs WHERE embedding MATCH ? AND k = ? ORDER BY distance")
      .all(qv, depth * 3) as { id: number | bigint; d: number }[];
    const hashOf = db.prepare("SELECT content_hash AS hash FROM chunks WHERE id = ?");
    const rows = knn.flatMap((r) => {
      const h = hashOf.get(Number(r.id)) as { hash: string } | undefined;
      return h ? [{ id: Number(r.id), d: r.d, hash: h.hash }] : [];
    });
    let rank = 0;
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.hash) || !liveContent.get(r.hash)) continue;
      seen.add(r.hash);
      const g = touch(r.hash, r.id);
      g.trace.vector = { rank: rank + 1, distance: Math.round(r.d * 1000) / 1000 };
      contribute(g, rank++);
      if (rank >= depth) break;
    }
  }

  // Filename list: share of query terms found in the file name. Covers files with no text.
  const qt = terms(q).filter((t) => t.length > 1);
  if (qt.length) {
    const files = db
      .prepare("SELECT id, path, content_hash FROM files WHERE deleted_at IS NULL AND state != 'skipped'")
      .all() as { id: number; path: string; content_hash: string | null }[];
    const scored = files
      .map((f) => {
        const name = basename(f.path).toLowerCase();
        const matched = qt.filter((t) => name.includes(t)).length;
        return { f, matched, frac: matched / qt.length };
      })
      .filter((x) => x.frac >= 0.5 || (qt.length === 1 && x.matched === 1))
      .sort((a, b) => b.frac - a.frac || a.f.path.length - b.f.path.length)
      .slice(0, depth);
    const seen = new Set<string>();
    let rank = 0;
    for (const { f, matched } of scored) {
      const key = f.content_hash ?? `f:${f.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const g = touch(key, null);
      g.trace.filename = { rank: rank + 1, matched };
      contribute(g, rank++);
    }
  }

  const top = [...groups.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  const pathsFor = db.prepare("SELECT path FROM files WHERE content_hash = ? AND deleted_at IS NULL ORDER BY length(path), path");
  const pathById = db.prepare("SELECT path FROM files WHERE id = ?");
  const chunk = db.prepare("SELECT text, page FROM chunks WHERE id = ?");
  const firstChunk = db.prepare("SELECT text, page FROM chunks WHERE content_hash = ? ORDER BY seq LIMIT 1");

  return top.map((g) => {
    const paths = g.key.startsWith("f:")
      ? [(pathById.get(Number(g.key.slice(2))) as { path: string }).path]
      : (pathsFor.all(g.key) as { path: string }[]).map((r) => r.path);
    const c = (g.chunkId !== null ? chunk.get(g.chunkId) : g.key.startsWith("f:") ? undefined : firstChunk.get(g.key)) as
      | { text: string; page: number | null }
      | undefined;
    return {
      paths,
      score: Math.round(g.score * 10000) / 10000,
      snippet: c ? snippetFor(c.text, q) : "",
      page: c?.page ?? null,
      trace: g.trace,
    };
  });
}
