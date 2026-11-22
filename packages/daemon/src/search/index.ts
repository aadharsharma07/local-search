import { basename, dirname } from "node:path";
import type { DB } from "../db/index.ts";
import type { Embedder } from "../embed/index.ts";
import { plan, timeFit, type QueryPlan } from "../planner/index.ts";
import { matchesPart, nameParts, queryTerms } from "../shared/text.ts";

export const RRF_K = 60;

export interface SearchOptions {
  limit?: number;
  /** Candidates pulled from each retriever before fusion. */
  depth?: number;
  /** "Now" for relative dates ("last summer"). */
  now?: Date;
  /** Record the query and its plan in the queries table (for later tuning). */
  log?: boolean;
  /** Cross-encoder scores for (query, snippets); reorders the top results when given. */
  rerank?: (q: string, docs: string[]) => Promise<number[]>;
  /** Alternative phrasings of a query; used only when the first results are weak. */
  expand?: (q: string) => Promise<string[]>;
}

export interface Trace {
  keyword?: { rank: number; bm25: number };
  vector?: { rank: number; distance: number };
  filename?: { rank: number; matched: number };
  bonus: number;
  /** Cross-encoder score when reranking ran. */
  rerank?: number;
  /** Found (also) through an expanded phrasing of the query. */
  expanded?: boolean;
  /** Score added by the query plan: time fit, recency, type, screenshot, origin. */
  plan?: Partial<Record<"time" | "recency" | "type" | "screenshot" | "origin", number>>;
}

/** Plan boosts, on the same scale as RRF scores (a #1 rank in one list is ~0.066). */
export const BOOST = { time: 0.04, recency: 0.03, type: 0.015, screenshot: 0.03, origin: 0.015 };
/** Recency only reorders candidates scoring at least this share of the top score. */
const RECENCY_MARGIN = 0.5;
const SCREENSHOT_NAME = /screen ?shots?|screen ?grab|snip/i;
const SCREENSHOT_TOOL = /software: [^.]*(snip|screen|capture|greenshot|sharex|lightshot)/i;

export interface SearchHit {
  /** Every live path holding this content (duplicates share one hit). First is the primary. */
  paths: string[];
  score: number;
  snippet: string;
  page: number | null;
  trace: Trace;
}

/** FTS5 query: terms OR-ed, prefix-matched when 3+ characters, so partial matches still rank. */
export function ftsQuery(terms: string[]): string | null {
  const t = terms.map((x) => x.replace(/"/g, "")).filter(Boolean);
  return t.length ? t.map((x) => (x.length >= 3 ? `"${x}"*` : `"${x}"`)).join(" OR ") : null;
}

/**
 * How distinctive each query term is in this index: inverse document frequency over indexed
 * contents. Words found almost everywhere weigh ~0, rare ones carry the match. Equal weights when
 * the index is empty.
 */
export function termWeights(db: DB, terms: string[]): Map<string, number> {
  const n = (db.prepare("SELECT count(*) AS n FROM contents").get() as { n: number }).n;
  const weights = new Map<string, number>();
  const df = db.prepare(
    "SELECT count(DISTINCT c.content_hash) AS df FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ?",
  );
  for (const t of terms) {
    if (!n) {
      weights.set(t, 1);
      continue;
    }
    const q = ftsQuery([t]);
    const d = q ? (df.get(q) as { df: number }).df : 0;
    weights.set(t, Math.max(0, Math.log((n + 1) / (d + 0.5))));
  }
  return weights;
}

/** A window of the chunk around the first query term, for display. */
export function snippetFor(text: string, q: string, width = 220): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of queryTerms(q)) {
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
 * Fused, plan-adjusted candidates for one query, best first: keyword (FTS5/BM25), vector
 * (sqlite-vec) and filename lists, fused with reciprocal rank fusion plus a small bonus for top
 * ranks, grouped per content so duplicates appear once, then adjusted by the query plan.
 */
async function rankGroups(db: DB, embedder: Embedder | null, q: string, opts: SearchOptions): Promise<Group[]> {
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

  // What the query asks for, and how distinctive each of its words is in this index.
  const qplan = plan(q, opts.now);
  if (opts.log) db.prepare("INSERT INTO queries(text, plan_json, ts) VALUES (?, ?, ?)").run(q, JSON.stringify(qplan), Date.now());
  const qterms = qplan.terms;
  const weights = termWeights(db, qterms);
  const maxW = Math.max(0, ...weights.values());
  const totalW = [...weights.values()].reduce((a, b) => a + b, 0);

  // Keyword list: rank chunks, keep each content's best chunk. Terms found almost everywhere are
  // left out of the FTS query (they only add noise), unless that would leave nothing.
  const strong = qterms.filter((t) => maxW === 0 || weights.get(t)! >= 0.3 * maxW);
  const fq = ftsQuery(strong.length ? strong : qterms);
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

  // Filename list: weighted share of query terms found in the file or folder name (split into
  // parts, stemmed). Rare terms count more than common ones. Covers files with no text.
  if (qterms.length) {
    const files = db
      .prepare("SELECT id, path, content_hash FROM files WHERE deleted_at IS NULL AND state != 'skipped'")
      .all() as { id: number; path: string; content_hash: string | null }[];
    const w = (t: string) => (totalW > 0 ? weights.get(t)! : 1);
    const denom = totalW > 0 ? totalW : qterms.length;
    const scored = files
      .map((f) => {
        // File name plus its folder's name, so "screenshot of ..." also matches files in Screenshots.
        const parts = nameParts(`${basename(dirname(f.path))} ${basename(f.path)}`);
        const hit = qterms.filter((t) => matchesPart(t, parts));
        return { f, matched: hit.length, cover: hit.reduce((a, t) => a + w(t), 0) / denom };
      })
      .filter((x) => x.matched > 0 && x.cover >= 0.5)
      .sort((a, b) => b.cover - a.cover || a.f.path.length - b.f.path.length)
      .slice(0, depth);
    // Equal name coverage means an equally good name match: ties share a rank (dense ranking),
    // so path length or listing order never decides between, say, a dozen "resume" files.
    const seen = new Set<string>();
    let rank = -1;
    let prev = Number.NaN;
    for (const { f, matched, cover } of scored) {
      const key = f.content_hash ?? `f:${f.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (cover !== prev) [rank, prev] = [rank + 1, cover];
      const g = touch(key, null);
      g.trace.filename = { rank: rank + 1, matched };
      contribute(g, rank);
    }
  }

  applyPlan(db, qplan, [...groups.values()]);
  return [...groups.values()].sort((a, b) => b.score - a.score);
}

/** Below this top score the first results count as weak (no list ranked anything first). */
export const WEAK_SCORE = 0.06;
/** How many top results the reranker reorders (S2: reranking costs grow with this). */
export const RERANK_TOP = 5;

/**
 * Hybrid search: keyword, vector and filename lists fused with RRF, adjusted by the query plan.
 * Optional, off by default (config switches): query expansion when the first results are weak,
 * fused with the original query at 2x weight; reranking of the top results.
 */
export async function search(db: DB, embedder: Embedder | null, q: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const limit = opts.limit ?? 10;
  let ranked = await rankGroups(db, embedder, q, opts);

  if (opts.expand && (!ranked.length || ranked[0]!.score < WEAK_SCORE)) {
    const merged = new Map(ranked.map((g) => [g.key, { ...g, score: 2 * g.score }]));
    for (const v of (await opts.expand(q)).slice(0, 3)) {
      const more = await rankGroups(db, embedder, v, { ...opts, log: false });
      more.forEach((g, i) => {
        const m = merged.get(g.key) ?? { ...g, score: 0, trace: { ...g.trace } };
        m.score += 1 / (RRF_K + i + 1);
        m.trace.expanded = true;
        merged.set(g.key, m);
      });
    }
    ranked = [...merged.values()].sort((a, b) => b.score - a.score);
  }

  const chunk = db.prepare("SELECT text, page FROM chunks WHERE id = ?");
  const firstChunk = db.prepare("SELECT text, page FROM chunks WHERE content_hash = ? ORDER BY seq LIMIT 1");
  const textOf = (g: Group) =>
    (g.chunkId !== null ? chunk.get(g.chunkId) : g.key.startsWith("f:") ? undefined : firstChunk.get(g.key)) as
      | { text: string; page: number | null }
      | undefined;

  if (opts.rerank && ranked.length > 1) {
    const head = ranked.slice(0, RERANK_TOP);
    const scores = await opts.rerank(q, head.map((g) => (textOf(g)?.text ?? "").slice(0, 1000)));
    const top = head[0]!.score;
    head
      .map((g, i) => ({ g, s: scores[i] ?? 0 }))
      .sort((a, b) => b.s - a.s)
      .forEach(({ g, s }, i) => {
        g.trace.rerank = Math.round(s * 1000) / 1000;
        g.score = top + 0.001 * (head.length - i);
      });
    ranked = [...head, ...ranked.slice(RERANK_TOP)].sort((a, b) => b.score - a.score);
  }

  const pathsFor = db.prepare("SELECT path FROM files WHERE content_hash = ? AND deleted_at IS NULL ORDER BY length(path), path");
  const pathById = db.prepare("SELECT path FROM files WHERE id = ?");
  return ranked.slice(0, limit).map((g) => {
    const paths = g.key.startsWith("f:")
      ? [(pathById.get(Number(g.key.slice(2))) as { path: string }).path]
      : (pathsFor.all(g.key) as { path: string }[]).map((r) => r.path);
    const c = textOf(g);
    return {
      paths,
      score: Math.round(g.score * 10000) / 10000,
      snippet: c ? snippetFor(c.text, q) : "",
      page: c?.page ?? null,
      trace: g.trace,
    };
  });
}

interface FileFacts {
  date: number; // date stored in the content (EXIF), else the newest modified time
  kinds: Set<string>;
  screenshot: boolean;
  downloaded: boolean;
}

/** Facts about a hit's files, read from existing columns (no extra index needed). */
function factsFor(db: DB, key: string): FileFacts | null {
  const rows = (
    key.startsWith("f:")
      ? db.prepare("SELECT path, mtime, kind, origin_url, NULL AS cdate, NULL AS text FROM files WHERE id = ?").all(Number(key.slice(2)))
      : db
          .prepare(
            `SELECT f.path, f.mtime, f.kind, f.origin_url, c.content_date AS cdate, c.text
             FROM files f JOIN contents c ON c.hash = f.content_hash WHERE f.content_hash = ? AND f.deleted_at IS NULL`,
          )
          .all(key)
  ) as { path: string; mtime: number; kind: string; origin_url: string | null; cdate: number | null; text: string | null }[];
  if (!rows.length) return null;
  const image = rows.some((r) => r.kind === "image");
  return {
    date: rows[0]!.cdate ?? Math.max(...rows.map((r) => r.mtime)),
    kinds: new Set(rows.map((r) => r.kind)),
    screenshot:
      image &&
      rows.some((r) => SCREENSHOT_NAME.test(`${basename(dirname(r.path))} ${basename(r.path)}`) || SCREENSHOT_TOOL.test(r.text ?? "")),
    downloaded: rows.some((r) => !!r.origin_url),
  };
}

/**
 * Apply the query plan to the fused candidates: boosts for fitting the asked-for time, being the
 * newest/oldest among close candidates, matching the file type, being a screenshot, or having a
 * download origin. Boosts only reorder retrieved candidates; nothing is filtered out.
 */
export function applyPlan(db: DB, p: QueryPlan, groups: Group[]): void {
  const wantsType = p.type !== "unspecified";
  if (!p.time && !p.recency && !wantsType && !p.screenshot && !p.origin) return;
  const facts = new Map<string, FileFacts | null>();
  const get = (g: Group) => {
    if (!facts.has(g.key)) facts.set(g.key, factsFor(db, g.key));
    return facts.get(g.key)!;
  };
  const add = (g: Group, k: keyof typeof BOOST, v: number) => {
    if (v <= 0) return;
    g.score += v;
    (g.trace.plan ??= {})[k] = Math.round(v * 10000) / 10000;
  };

  // "My latest X" asks for the newest X: among candidates that match the words themselves (by name
  // or keyword) and score close to the top, order by date, ahead of everything else.
  const topScore = Math.max(0, ...groups.map((g) => g.score));
  if (p.recency && topScore > 0) {
    const close = groups.filter((g) => (g.trace.filename || g.trace.keyword) && g.score >= RECENCY_MARGIN * topScore && get(g));
    const byDate = close.sort((a, b) => (p.recency === "newest" ? get(b)!.date - get(a)!.date : get(a)!.date - get(b)!.date));
    byDate.forEach((g, i) => {
      const target = topScore + BOOST.recency * (1 - i / Math.max(1, byDate.length - 1));
      add(g, "recency", target - g.score);
    });
  }
  for (const g of groups) {
    const f = get(g);
    if (!f) continue;
    if (p.time) add(g, "time", BOOST.time * timeFit(f.date, p.time));
    if (wantsType && f.kinds.has(p.type)) add(g, "type", BOOST.type);
    if (p.screenshot && f.screenshot) add(g, "screenshot", BOOST.screenshot);
    if (p.origin && f.downloaded) add(g, "origin", BOOST.origin);
  }
}
