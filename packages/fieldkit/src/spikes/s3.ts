import Database from "better-sqlite3";
import { basename, normalize } from "node:path";
import { chunkText } from "../chunk.ts";
import type { FieldkitConfig } from "../config.ts";
import { indexable, sample, type Corpus } from "../corpus.ts";
import { cosine, EMBEDDERS, loadModel, type EmbeddingCandidate } from "../models.ts";
import { round, type SpikeResult } from "../report.ts";
import { scoreRankings, type TestSet } from "../testset.ts";
import type { WorkerClient } from "../worker.ts";

export interface Doc {
  path: string;
  title: string;
  text: string;
  chunks: string[];
}

/** Extract the evaluation corpus: every expected file plus a sample of distractors. */
export async function buildEvalDocs(
  cfg: FieldkitConfig,
  testset: TestSet,
  corpus: Corpus | null,
  worker: WorkerClient,
  log: (s: string) => void,
): Promise<{ docs: Doc[]; failed: number }> {
  const expected = [...new Set(testset.queries.flatMap((q) => q.expected))];
  const want = new Set(expected.map((p) => normalize(p).toLowerCase()));
  const distractors = corpus
    ? sample(indexable(corpus, cfg.maxFileBytes).filter((f) => !want.has(normalize(f.path).toLowerCase())), cfg.s3Distractors).map((f) => f.path)
    : [];
  const paths = [...expected, ...distractors];
  const docs: Doc[] = [];
  let failed = 0;
  for (const [i, path] of paths.entries()) {
    if (i % 100 === 0) log(`  extracting ${i}/${paths.length}`);
    const r = await worker.extract(path);
    if (!r.ok) {
      failed++;
      // Keep failed files searchable by name only, like the real index would.
      docs.push({ path, title: basename(path), text: "", chunks: [] });
      continue;
    }
    docs.push({ path, title: basename(path), text: r.text, chunks: chunkText(r.text).map((c) => c.text) });
  }
  return { docs, failed };
}

/** BM25 baseline over the same chunks (FTS5 on chunk text + filename). */
function bm25Rankings(docs: Doc[], queries: string[]): string[][] {
  const db = new Database(":memory:");
  db.exec("CREATE VIRTUAL TABLE c USING fts5(title, text, doc UNINDEXED, tokenize='porter unicode61')");
  const ins = db.prepare("INSERT INTO c(title, text, doc) VALUES (?, ?, ?)");
  db.transaction(() => {
    docs.forEach((d, i) => {
      if (!d.chunks.length) ins.run(d.title, "", i);
      for (const ch of d.chunks) ins.run(d.title, ch, i);
    });
  })();
  const stmt = db.prepare(
    "SELECT doc, min(bm25(c, 4.0, 1.0)) AS s FROM c WHERE c MATCH ? GROUP BY doc ORDER BY s LIMIT 10",
  );
  return queries.map((q) => {
    const terms = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t}"*`).join(" OR ");
    return (stmt.all(match) as { doc: number }[]).map((r) => docs[r.doc]!.path);
  });
}

async function vectorRankings(cfg: FieldkitConfig, m: EmbeddingCandidate, docs: Doc[], queries: string[], log: (s: string) => void) {
  const model = await loadModel(m.uri, cfg.modelsDir);
  const ctx = await model.createEmbeddingContext({ contextSize: 2048 });
  const vecs: { doc: number; v: readonly number[] }[] = [];
  const t0 = performance.now();
  let n = 0;
  for (const [i, d] of docs.entries()) {
    const pieces = d.chunks.length ? d.chunks : [""];
    for (const ch of pieces) {
      const input = m.doc(d.title, ch).slice(0, 6000);
      vecs.push({ doc: i, v: (await ctx.getEmbeddingFor(input)).vector });
      n++;
    }
    if (i % 200 === 0) log(`  ${m.id}: embedded ${i}/${docs.length} files`);
  }
  const perSec = n / ((performance.now() - t0) / 1000);
  const rankings: string[][] = [];
  for (const q of queries) {
    const qv = (await ctx.getEmbeddingFor(m.query(q))).vector;
    const best = new Map<number, number>();
    for (const { doc, v } of vecs) best.set(doc, Math.max(best.get(doc) ?? -1, cosine(qv, v)));
    rankings.push([...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([d]) => docs[d]!.path));
  }
  await ctx.dispose();
  await model.dispose();
  return { rankings, chunks: n, perSec };
}

/** S3: which embedding model finds your files best? Compared against plain BM25. */
export async function s3(
  cfg: FieldkitConfig,
  testset: TestSet,
  evalDocs: { docs: Doc[]; failed: number },
  log: (s: string) => void,
  models = EMBEDDERS,
): Promise<Omit<SpikeResult, "id" | "title" | "ms">> {
  const { docs, failed } = evalDocs;
  const qs = testset.queries.map((q) => q.q);
  const results: Record<string, unknown> = {};

  const bm = scoreRankings(testset.queries, bm25Rankings(docs, qs));
  results["bm25"] = { recallAt5: round(bm.recallAtK, 3), mrr: round(bm.mrr, 3), perQuery: bm.perQuery };

  const scored: { id: string; recall: number; mrr: number }[] = [];
  for (const m of models) {
    log(`  S3: ${m.id}`);
    try {
      const v = await vectorRankings(cfg, m, docs, qs, log);
      const s = scoreRankings(testset.queries, v.rankings);
      scored.push({ id: m.id, recall: s.recallAtK, mrr: s.mrr });
      results[m.id] = { recallAt5: round(s.recallAtK, 3), mrr: round(s.mrr, 3), chunks: v.chunks, embedPerSec: round(v.perSec), perQuery: s.perQuery };
    } catch (e) {
      results[m.id] = { error: (e as Error).message.slice(0, 300) };
    }
  }

  scored.sort((a, b) => b.recall - a.recall || b.mrr - a.mrr);
  const top = scored[0];
  // Rule from the blueprint: smallest model within 2 points of the best recall wins.
  const sizes = Object.fromEntries(models.map((m) => [m.id, m.approxMb]));
  const pick = top
    ? scored.filter((s) => s.recall >= top.recall - 0.02).sort((a, b) => sizes[a.id]! - sizes[b.id]!)[0]
    : undefined;

  return {
    verdict: pick ? "INFO" : "FAIL",
    summary: pick
      ? `Pick ${pick.id} (recall@5 ${round(pick.recall * 100)}%, MRR ${round(pick.mrr, 2)}); BM25 alone ${round(bm.recallAtK * 100)}%; ${docs.length} files, ${failed} failed extraction`
      : "No embedding model ran",
    data: { queries: qs.length, files: docs.length, extractionFailed: failed, missingExpected: testset.missing.length, pick: pick?.id ?? null, results },
  };
}
