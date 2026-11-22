// Optional models behind config switches (both off by default; see docs/DECISIONS.md).
// Loaded only when switched on, so the always-resident set stays the embedder alone.

export const RERANKER_URI = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
export const EXPANSION_URI = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";

async function loadModel(uri: string, modelsDir: string) {
  const { getLlama, resolveModelFile } = await import("node-llama-cpp");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(modelsDir, { recursive: true });
  const llama = await getLlama({ gpu: "auto" });
  const modelPath = await resolveModelFile(uri, { directory: modelsDir, cli: false });
  return llama.loadModel({ modelPath });
}

/** Cross-encoder reranker: scores (query, snippet) pairs. */
export async function loadReranker(modelsDir: string): Promise<(q: string, docs: string[]) => Promise<number[]>> {
  const model = await loadModel(RERANKER_URI, modelsDir);
  const ctx = await model.createRankingContext({ contextSize: 4096 });
  return (q, docs) => ctx.rankAll(q, docs);
}

/** Parse up to three alternative queries from model output, one per line. */
export function parseVariants(out: string, original: string): string[] {
  const seen = new Set([original.trim().toLowerCase()]);
  const variants: string[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const v = raw.replace(/^\s*(?:[-*\d.)]+|lex:|vec:|hyde:)\s*/i, "").trim();
    if (v.length < 2 || v.length > 200 || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    variants.push(v);
    if (variants.length === 3) break;
  }
  return variants;
}

/** Query expansion: a small LLM rewrites a weak query into a few alternatives. */
export async function loadExpander(modelsDir: string): Promise<(q: string) => Promise<string[]>> {
  const { LlamaChatSession } = await import("node-llama-cpp");
  const model = await loadModel(EXPANSION_URI, modelsDir);
  const ctx = await model.createContext({ contextSize: 1024 });
  return async (q) => {
    const session = new LlamaChatSession({ contextSequence: ctx.getSequence() });
    try {
      const out = await session.prompt(
        `Rewrite this file search into 3 short alternative searches, one per line, no numbering:\n${q}`,
        { maxTokens: 100, temperature: 0 },
      );
      return parseVariants(out, q);
    } finally {
      session.dispose({ disposeSequence: true });
    }
  };
}
