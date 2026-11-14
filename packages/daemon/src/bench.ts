import { mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { join, normalize } from "node:path";
import type { DB } from "./db/index.ts";
import type { Embedder } from "./embed/index.ts";
import { stateCounts } from "./ingest/index.ts";
import { search } from "./search/index.ts";
import { scoreRankings, type TestSet } from "./shared/testset.ts";

export interface BenchResult {
  createdAt: string;
  machine: { platform: string; release: string; arch: string; cpu: string };
  embedder: string;
  index: { states: Record<string, number>; chunks: number };
  queries: { total: number; inScope: number; outOfScope: number };
  recallAt5: number;
  mrr: number;
  latencyMs: { p50: number; p95: number; max: number };
  /** Per in-scope query: rank of the first expected file (null = not in top 10). No query text. */
  perQuery: { hitAt: number | null; needs?: string; ms: number }[];
}

const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))]!;
};

/**
 * Score the live index against a test set. Only queries whose expected file is indexed count
 * ("in scope"), so a one-folder index can be benched against the full test set.
 */
export async function bench(db: DB, embedder: Embedder, testset: TestSet): Promise<BenchResult> {
  const live = db.prepare("SELECT 1 FROM files WHERE path = ? AND deleted_at IS NULL AND state IN ('indexed', 'enriched')");
  const key = (p: string) => normalize(p).normalize("NFC");
  const inScope = testset.queries.filter((t) => t.expected.some((e) => live.get(key(e))));

  const rankings: string[][] = [];
  const times: number[] = [];
  for (const t of inScope) {
    const t0 = performance.now();
    const hits = await search(db, embedder, t.q, { limit: 10 });
    times.push(performance.now() - t0);
    rankings.push(hits.flatMap((h) => h.paths));
  }
  // Rank is by result position, so collapse duplicate paths back to their hit's position.
  const byHit = inScope.map((_, i) => rankings[i]!);
  const s = scoreRankings(inScope, byHit);

  return {
    createdAt: new Date().toISOString(),
    machine: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown" },
    embedder: embedder.spec.model,
    index: {
      states: stateCounts(db),
      chunks: (db.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n,
    },
    queries: { total: testset.queries.length, inScope: inScope.length, outOfScope: testset.queries.length - inScope.length },
    recallAt5: Math.round(s.recallAtK * 1000) / 1000,
    mrr: Math.round(s.mrr * 1000) / 1000,
    latencyMs: { p50: Math.round(q(times, 0.5)), p95: Math.round(q(times, 0.95)), max: Math.round(Math.max(0, ...times)) },
    perQuery: s.perQuery.map((p, i) => ({ ...p, ms: Math.round(times[i]!) })),
  };
}

export function writeBench(r: BenchResult, outDir: string): string {
  const dir = join(outDir, `${r.createdAt.replace(/[:.]/g, "-").slice(0, 19)}-bench`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bench.json"), JSON.stringify(r, null, 2));
  const md = [
    `# Bench — ${r.createdAt.slice(0, 16).replace("T", " ")}`,
    "",
    `${r.machine.platform} ${r.machine.release} · ${r.machine.cpu} · embedder ${r.embedder}`,
    "",
    `- Queries in scope: ${r.queries.inScope} of ${r.queries.total} (the rest point at files not in this index)`,
    `- **recall@5: ${Math.round(r.recallAt5 * 1000) / 10}%** · MRR ${r.mrr}`,
    `- Latency: p50 ${r.latencyMs.p50} ms · p95 ${r.latencyMs.p95} ms · max ${r.latencyMs.max} ms`,
    `- Index: ${JSON.stringify(r.index.states)} · ${r.index.chunks} chunks`,
    "",
    "Aggregate numbers only: no queries, file names or paths.",
  ].join("\n");
  writeFileSync(join(dir, "summary.md"), md + "\n");
  return dir;
}
