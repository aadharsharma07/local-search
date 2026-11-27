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

export type RerankFn = (q: string, docs: string[]) => Promise<number[]>;
export type ExpandFn = (q: string) => Promise<string[]>;

/** A loaded model's entry point plus a way to free its memory. */
export interface Loaded<T> {
  value: T;
  dispose(): Promise<void>;
}

/**
 * Loads on first use and unloads after idleMs without use, so "search harder" costs no GPU memory
 * until it is needed and gives it back afterwards.
 */
export class IdleLoader<T> {
  private loading: Promise<Loaded<T>> | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private open: () => Promise<Loaded<T>>,
    private idleMs = 10 * 60_000,
  ) {}

  get loaded(): boolean {
    return this.loading !== null;
  }

  async get(): Promise<T> {
    if (!this.loading) {
      this.loading = this.open();
      this.loading.catch(() => (this.loading = null)); // a failed load is retried next time
    }
    const l = await this.loading;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.close(), this.idleMs);
    this.timer.unref();
    return l.value;
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const l = this.loading;
    this.loading = null;
    if (l) await (await l).dispose();
  }
}

/** Cross-encoder reranker: scores (query, snippet) pairs. */
export async function openReranker(modelsDir: string): Promise<Loaded<RerankFn>> {
  const model = await loadModel(RERANKER_URI, modelsDir);
  const ctx = await model.createRankingContext({ contextSize: 4096 });
  return {
    value: (q, docs) => ctx.rankAll(q, docs),
    dispose: async () => {
      await ctx.dispose();
      await model.dispose();
    },
  };
}

export async function loadReranker(modelsDir: string): Promise<RerankFn> {
  return (await openReranker(modelsDir)).value;
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
export async function openExpander(modelsDir: string): Promise<Loaded<ExpandFn>> {
  const { LlamaChatSession } = await import("node-llama-cpp");
  const model = await loadModel(EXPANSION_URI, modelsDir);
  const ctx = await model.createContext({ contextSize: 1024 });
  return {
    value: async (q) => {
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
    },
    dispose: async () => {
      await ctx.dispose();
      await model.dispose();
    },
  };
}

export async function loadExpander(modelsDir: string): Promise<ExpandFn> {
  return (await openExpander(modelsDir)).value;
}

/**
 * "Search harder" for one request: reranker and expander, loaded on first use and unloaded after
 * ten idle minutes. Both load together (one wait, ~1.5 GB of an 8 GB card).
 */
export function deepSearch(modelsDir: string, idleMs?: number): IdleLoader<{ rerank: RerankFn; expand: ExpandFn }> {
  return new IdleLoader(async () => {
    const r = await openReranker(modelsDir);
    let e: Loaded<ExpandFn>;
    try {
      e = await openExpander(modelsDir);
    } catch (err) {
      await r.dispose(); // don't keep half of the pair loaded
      throw err;
    }
    return {
      value: { rerank: r.value, expand: e.value },
      dispose: async () => {
        await Promise.all([r.dispose(), e.dispose()]);
      },
    };
  }, idleMs);
}
