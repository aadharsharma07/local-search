import type { FieldkitConfig } from "../config.ts";
import { EMBEDDERS, gpuInfo, loadModel, RERANKER_URI } from "../models.ts";
import { quantile, round, type SpikeResult } from "../report.ts";

// Pass criteria from the blueprint.
const MIN_EMBED_PER_SEC = 100;
const MAX_RERANK_MS = 300;

/** Synthetic chunks of realistic length (~900 tokens); content does not matter for speed. */
function syntheticChunks(n: number): string[] {
  const words =
    "invoice receipt order total payment account statement chair desk lease rent tax refund income lecture notes eigenvalue matrix function return value photo backup schedule meeting project budget travel flight hotel booking confirmation".split(" ");
  let s = 7;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: n }, (_, i) => {
    const parts = [`Document ${i}.`];
    for (let w = 0; w < 650; w++) parts.push(words[Math.floor(rand() * words.length)]!);
    return parts.join(" ");
  });
}

/** S2: embedding throughput and rerank latency on this machine's GPU. */
export async function s2(cfg: FieldkitConfig, opts: { chunks?: number } = {}): Promise<Omit<SpikeResult, "id" | "title" | "ms">> {
  const n = opts.chunks ?? 1000;
  const gpu = await gpuInfo();
  const chunks = syntheticChunks(n);
  const embedder = EMBEDDERS[0]!;

  const model = await loadModel(embedder.uri, cfg.modelsDir);
  const ctx = await model.createEmbeddingContext({ contextSize: 2048 });
  await ctx.getEmbeddingFor(embedder.doc("warmup", chunks[0]!));
  const t0 = performance.now();
  let dims = 0;
  for (const c of chunks) dims = (await ctx.getEmbeddingFor(embedder.doc("doc", c))).vector.length;
  const embedPerSec = n / ((performance.now() - t0) / 1000);
  const q0 = performance.now();
  for (let i = 0; i < 20; i++) await ctx.getEmbeddingFor(embedder.query(`where did I buy that office chair ${i}`));
  const queryEmbedMs = (performance.now() - q0) / 20;
  await ctx.dispose();
  await model.dispose();

  const rmodel = await loadModel(RERANKER_URI, cfg.modelsDir);
  const rctx = await rmodel.createRankingContext({ contextSize: 4096 });
  const docs = chunks.slice(0, 40).map((c) => c.slice(0, 2400));
  await rctx.rankAll("warm up", docs.slice(0, 2));
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r0 = performance.now();
    await rctx.rankAll("where did I buy that office chair three years ago", docs);
    times.push(performance.now() - r0);
  }
  await rctx.dispose();
  await rmodel.dispose();

  const rerankMs = quantile(times, 0.5);
  const pass = embedPerSec >= MIN_EMBED_PER_SEC && rerankMs <= MAX_RERANK_MS;
  return {
    verdict: pass ? "PASS" : "FAIL",
    summary: `${gpu.backend}: embed ${round(embedPerSec)} chunks/s (need ≥${MIN_EMBED_PER_SEC}), rerank 40 in ${Math.round(rerankMs)} ms (need ≤${MAX_RERANK_MS}), query embed ${round(queryEmbedMs)} ms`,
    data: {
      gpu,
      embedder: embedder.id,
      dims,
      chunks: n,
      embedPerSec: round(embedPerSec),
      queryEmbedMs: round(queryEmbedMs),
      rerank: { docs: 40, p50Ms: Math.round(rerankMs), runsMs: times.map(Math.round) },
      criteria: { minEmbedPerSec: MIN_EMBED_PER_SEC, maxRerankMs: MAX_RERANK_MS },
    },
  };
}
