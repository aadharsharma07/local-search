import type { FieldkitConfig } from "../config.ts";
import { loadModel } from "../models.ts";
import { nice, quantile, type SpikeResult } from "../report.ts";

/** Query expansion (qmd's fine-tune) and the general model for labels, typed records, answers. */
export const GENERATORS = [
  { id: "qmd-expansion-1.7b", uri: "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf", role: "query expansion" },
  { id: "qwen3-4b-instruct", uri: "hf:unsloth/Qwen3-4B-Instruct-2507-GGUF/Qwen3-4B-Instruct-2507-Q4_K_M.gguf", role: "labels, receipts, answers" },
] as const;

const EXPANSION_TOKENS = 100; // typical lex/vec/hyde output
const MAX_INLINE_EXPANSION_MS = 600; // above this, expansion only runs when first results are weak

const PROMPT =
  "Rewrite this file search into keyword lines (lex:), meaning lines (vec:) and one hypothetical matching document line (hyde:).\n" +
  "Search: where did I buy that office chair three years ago\n" +
  "Context: personal files on a Windows PC, including receipts, bills, tax forms, notes and screenshots.\n";

/** S7: text generation speed on this GPU, which decides whether expansion can run per query. */
export async function s7(cfg: FieldkitConfig, opts: { tokens?: number; runs?: number } = {}): Promise<Omit<SpikeResult, "id" | "title" | "ms">> {
  const tokens = opts.tokens ?? 120;
  const runs = Math.max(2, opts.runs ?? 3); // first run is warm-up
  const { LlamaCompletion } = await import("node-llama-cpp");
  const results: Record<string, unknown> = {};
  let expansionMs: number | null = null;

  for (const g of GENERATORS) {
    try {
      const model = await loadModel(g.uri, cfg.modelsDir);
      const ctx = await model.createContext({ contextSize: 2048 });
      const ttft: number[] = [];
      const decode: number[] = [];
      for (let run = 0; run < runs; run++) {
        const seq = ctx.getSequence();
        const completion = new LlamaCompletion({ contextSequence: seq });
        const t0 = performance.now();
        let first = 0;
        let produced = 0;
        await completion.generateCompletion(PROMPT, {
          maxTokens: tokens,
          temperature: 0,
          onToken: (t) => {
            if (!first) first = performance.now();
            produced += t.length;
          },
        });
        const end = performance.now();
        if (run > 0 && first && produced > 1) {
          // first run is warm-up
          ttft.push(first - t0);
          decode.push((produced - 1) / ((end - first) / 1000));
        }
        completion.dispose();
        seq.dispose();
      }
      await ctx.dispose();
      await model.dispose();
      const t = quantile(ttft, 0.5);
      const d = quantile(decode, 0.5);
      const ms100 = t + (EXPANSION_TOKENS / d) * 1000;
      if (g.id === "qmd-expansion-1.7b") expansionMs = ms100;
      results[g.id] = { role: g.role, ttftMs: Math.round(t), decodeTokPerSec: nice(d), msFor100Tokens: Math.round(ms100) };
    } catch (e) {
      results[g.id] = { role: g.role, error: (e as Error).message.slice(0, 300) };
    }
  }

  const inline = expansionMs !== null && expansionMs <= MAX_INLINE_EXPANSION_MS;
  const fmt = (id: string) => {
    const r = results[id] as { decodeTokPerSec?: number; msFor100Tokens?: number; error?: string };
    return r.error ? `${id} failed` : `${id} ${r.decodeTokPerSec} tok/s (${r.msFor100Tokens} ms per 100 tokens)`;
  };
  return {
    verdict: expansionMs === null ? "FAIL" : "INFO",
    summary:
      `${GENERATORS.map((g) => fmt(g.id)).join(" · ")} → expansion ` +
      (inline ? `can run on every query (≤${MAX_INLINE_EXPANSION_MS} ms)` : `only when first results are weak (>${MAX_INLINE_EXPANSION_MS} ms)`),
    data: { results, expansionInline: inline, criteria: { maxInlineExpansionMs: MAX_INLINE_EXPANSION_MS, expansionTokens: EXPANSION_TOKENS } },
  };
}
