import type { FieldkitConfig } from "../config.ts";
import { EMBEDDERS, gpuInfo, loadModel, RERANKER_URI } from "../models.ts";
import { quantile, round, type SpikeResult } from "../report.ts";

// Pass criteria. Embedding cost is ~2 x params x tokens, so raw chunks/s is the wrong target:
// what matters is whether the first full index finishes overnight and queries stay fast.
const MAX_INDEX_HOURS = 12; // first full index, from the census + S5 chunk estimate
const MAX_QUERY_EMBED_MS = 50;
const MAX_RERANK_MS = 400; // rerank RERANK_DOCS snippets of ~SNIPPET_CHARS
export const RERANK_DOCS = 10;
export const SNIPPET_CHARS = 1000; // ~250 tokens: the best-matching window of a chunk
const FALLBACK_CHUNKS = 200_000; // used when no S5 estimate is available

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

/** S2: embedding throughput, overnight index estimate and rerank latency on this GPU. */
export async function s2(
  cfg: FieldkitConfig,
  opts: { chunks?: number; estimatedChunks?: number; quick?: boolean; log?: (s: string) => void } = {},
): Promise<Omit<SpikeResult, "id" | "title" | "ms">> {
  const n = opts.chunks ?? 300;
  // Progress lines pinpoint where a native crash happens (they end up in the crash log tail).
  const t00 = performance.now();
  const log = (s: string) => opts.log?.(`  [s2 +${Math.round((performance.now() - t00) / 1000)}s] ${s}`);
  const gpu = await gpuInfo();
  const chunks = syntheticChunks(n);
  const embedder = EMBEDDERS[0]!;

  log(`gpu ${gpu.backend}; loading ${embedder.id}`);
  const model = await loadModel(embedder.uri, cfg.modelsDir);
  log("embedder loaded");
  const tokensPerChunk = model.tokenize(embedder.doc("doc", chunks[0]!)).length;
  const ctx = await model.createEmbeddingContext({ contextSize: 2048 });
  await ctx.getEmbeddingFor(embedder.doc("warmup", chunks[0]!));
  const t0 = performance.now();
  let dims = 0;
  for (const [i, c] of chunks.entries()) {
    dims = (await ctx.getEmbeddingFor(embedder.doc("doc", c))).vector.length;
    if ((i + 1) % 10 === 0) log(`embedded ${i + 1}/${n}`);
  }
  const embedPerSec = n / ((performance.now() - t0) / 1000);
  const qTimes: number[] = [];
  for (let i = 0; i < 20; i++) {
    const q0 = performance.now();
    await ctx.getEmbeddingFor(embedder.query(`where did I buy that office chair ${i}`));
    qTimes.push(performance.now() - q0);
  }
  const queryEmbedMs = quantile(qTimes, 0.5);
  log("disposing embedder");
  await ctx.dispose();
  await model.dispose();
  log("loading reranker");

  const estChunks = opts.estimatedChunks && opts.estimatedChunks > 0 ? opts.estimatedChunks : FALLBACK_CHUNKS;
  const indexHours = estChunks / embedPerSec / 3600;

  // Rerank: the planned setting (10 short snippets) is the pass criterion; the larger settings
  // are recorded so the trade-off is visible.
  const rmodel = await loadModel(RERANKER_URI, cfg.modelsDir);
  const rctx = await rmodel.createRankingContext({ contextSize: 4096 });
  const query = "where did I buy that office chair three years ago";
  await rctx.rankAll("warm up", [chunks[0]!.slice(0, 200)]);
  const rerank = async (docs: number, chars: number, runs = 3) => {
    const set = chunks.slice(0, docs).map((c) => c.slice(0, chars));
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const r0 = performance.now();
      await rctx.rankAll(query, set);
      times.push(performance.now() - r0);
    }
    return Math.round(quantile(times, 0.5));
  };
  log("reranker loaded");
  const rerankPlanned = await rerank(Math.min(RERANK_DOCS, n), SNIPPET_CHARS, opts.quick ? 1 : 5);
  log("planned rerank done");
  const rerankVariants = opts.quick
    ? {}
    : { "20x1000": await rerank(20, 1000), "10x2400": await rerank(10, 2400), "40x2400": await rerank(40, 2400, 1) };
  await rctx.dispose();
  await rmodel.dispose();
  log("done");

  const pass = indexHours <= MAX_INDEX_HOURS && queryEmbedMs <= MAX_QUERY_EMBED_MS && rerankPlanned <= MAX_RERANK_MS;
  return {
    verdict: pass ? "PASS" : "FAIL",
    summary:
      `${gpu.backend}: ${round(embedPerSec)} chunks/s → first index ≈${round(indexHours)} h for ${estChunks.toLocaleString("en-US")} chunks (need ≤${MAX_INDEX_HOURS}); ` +
      `query embed ${round(queryEmbedMs)} ms (≤${MAX_QUERY_EMBED_MS}); rerank ${RERANK_DOCS} snippets ${rerankPlanned} ms (≤${MAX_RERANK_MS})`,
    data: {
      gpu,
      embedder: embedder.id,
      dims,
      chunks: n,
      tokensPerChunk,
      embedPerSec: round(embedPerSec),
      embedTokensPerSec: Math.round(embedPerSec * tokensPerChunk),
      queryEmbedMs: round(queryEmbedMs),
      indexEstimate: { chunks: estChunks, fromS5: Boolean(opts.estimatedChunks), hours: round(indexHours) },
      rerank: { plannedMs: rerankPlanned, docs: RERANK_DOCS, snippetChars: SNIPPET_CHARS, variantsMs: rerankVariants },
      criteria: { maxIndexHours: MAX_INDEX_HOURS, maxQueryEmbedMs: MAX_QUERY_EMBED_MS, maxRerankMs: MAX_RERANK_MS },
    },
  };
}
