import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

export interface TestQuery {
  q: string;
  expected: string[]; // absolute after loading
  needs?: "ocr" | "captions";
}
export interface TestSet {
  root: string;
  now?: string;
  queries: TestQuery[];
  missing: string[]; // expected files that do not exist (reported as a count only)
}

/**
 * Test set file shape:
 * { "root": "C:\\Users\\me", "queries": [{ "q": "...", "expected": ["Downloads\\x.pdf"] }] }
 * "expected" paths may be absolute or relative to "root" (default: the file's own folder).
 */
export function loadTestSet(path: string, defaultRoot?: string): TestSet {
  if (!existsSync(path)) throw new Error(`No test set at ${path}. See docs/FIELD-VISIT.md, step 3.`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    root?: string;
    now?: string;
    queries: { q: string; expected: string[]; needs?: TestQuery["needs"] }[];
  };
  const root = raw.root ?? defaultRoot ?? join(path, "..");
  const missing: string[] = [];
  const queries = raw.queries.map((q) => ({
    ...q,
    expected: q.expected.map((e) => {
      const abs = normalize(isAbsolute(e) ? e : join(root, e));
      if (!existsSync(abs)) missing.push(abs);
      return abs;
    }),
  }));
  return { root, now: raw.now, queries, missing };
}

/** recall@k: share of queries with at least one expected file in the top k. MRR over top 10. */
export function scoreRankings(queries: TestQuery[], rankings: string[][], k = 5) {
  let hits = 0;
  let mrr = 0;
  const perQuery: { hitAt: number | null; needs?: string }[] = [];
  queries.forEach((q, i) => {
    const ranked = rankings[i] ?? [];
    const want = new Set(q.expected.map((e) => normalize(e).toLowerCase()));
    const pos = ranked.slice(0, 10).findIndex((p) => want.has(normalize(p).toLowerCase()));
    if (pos >= 0 && pos < k) hits++;
    if (pos >= 0) mrr += 1 / (pos + 1);
    perQuery.push({ hitAt: pos >= 0 ? pos + 1 : null, needs: q.needs });
  });
  const n = queries.length || 1;
  return { recallAtK: hits / n, mrr: mrr / n, k, perQuery };
}
