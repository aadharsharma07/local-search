import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadTestSet } from "@local-search/daemon/shared/testset";
import { REPO_ROOT } from "./config.ts";
import { round } from "./report.ts";

export interface Labeled {
  q: string;
  time: boolean;
  origin: boolean;
  type: string;
  content: string;
  source: "fixture" | "yours";
}
export interface Prediction {
  time: boolean;
  origin: boolean;
  type: string;
  content: string;
}
const FACETS = ["time", "origin", "type", "content"] as const;

/** Fixture labels plus any facet labels in your private test set. */
export function loadLabeled(testsetPath?: string): Labeled[] {
  const fixture = (
    JSON.parse(readFileSync(join(REPO_ROOT, "fixtures", "laya-facets.json"), "utf8")) as {
      queries: Omit<Labeled, "source">[];
    }
  ).queries.map((l) => ({ ...l, source: "fixture" as const }));
  const yours: Labeled[] = [];
  if (testsetPath && existsSync(testsetPath)) {
    for (const t of loadTestSet(testsetPath).queries) if (t.facets) yours.push({ q: t.q, ...t.facets, source: "yours" });
  }
  return [...fixture, ...yours];
}

/**
 * Accuracy per facet, per source. Misses are listed for fixture queries only: your own queries
 * are private and only counted.
 */
export function scoreFacets(labeled: Labeled[], preds: Prediction[]) {
  const out: Record<string, { n: number; accuracy: Record<string, number>; mean: number }> = {};
  const misses: { q: string; facet: string; want: string; got: string }[] = [];
  for (const source of ["fixture", "yours"] as const) {
    const idx = labeled.map((l, i) => [l, i] as const).filter(([l]) => l.source === source);
    if (!idx.length) continue;
    const acc: Record<string, number> = {};
    for (const f of FACETS) {
      const ok = idx.filter(([l, i]) => preds[i]![f] === l[f]).length;
      acc[f] = round(ok / idx.length, 3);
      if (source === "fixture")
        for (const [l, i] of idx) if (preds[i]![f] !== l[f]) misses.push({ q: l.q, facet: f, want: String(l[f]), got: String(preds[i]![f]) });
    }
    const mean = round(FACETS.reduce((a, f) => a + acc[f]!, 0) / FACETS.length, 3);
    out[source] = { n: idx.length, accuracy: acc, mean };
  }
  return { bySource: out, misses };
}

/** The verdict uses your queries when there are at least 10 labeled ones, else the fixtures. */
export function headline(scored: ReturnType<typeof scoreFacets>) {
  const y = scored.bySource.yours;
  return y && y.n >= 10 ? { source: "yours", ...y } : { source: "fixture", ...scored.bySource.fixture! };
}
