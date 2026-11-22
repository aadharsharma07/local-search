import type { EmbeddingSpec } from "../db/index.ts";

/** Turns text into unit-length vectors. One instance per process; implementations own their model. */
export interface Embedder {
  readonly spec: EmbeddingSpec;
  embedDocument(title: string, text: string): Promise<Float32Array>;
  embedQuery(query: string): Promise<Float32Array>;
  close(): Promise<void>;
}

export const CHUNK_TOKENS = 900;
export const OVERLAP_TOKENS = 135;

function normalize(v: ArrayLike<number>): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  const s = n > 0 ? 1 / Math.sqrt(n) : 0;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * s;
  return out;
}

/**
 * Deterministic bag-of-words embedder (feature hashing). No model, no download: used by tests
 * and CI so the whole pipeline runs without a GPU. Retrieval quality is keyword-level only.
 */
export class HashEmbedder implements Embedder {
  readonly spec: EmbeddingSpec;
  constructor(private dims = 256) {
    this.spec = {
      model: "hash-v1",
      dims,
      queryFormat: "{q}",
      docFormat: "{title} {text}",
      chunkTokens: CHUNK_TOKENS,
      overlapTokens: OVERLAP_TOKENS,
    };
  }
  private vec(text: string): Float32Array {
    const v = new Float32Array(this.dims);
    for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      const t = raw.length > 3 ? raw.replace(/s$/, "") : raw;
      let h = 2166136261;
      for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
      const idx = (h >>> 0) % this.dims;
      v[idx]! += (h & 0x80000000) === 0 ? 1 : -1;
    }
    return normalize(v);
  }
  async embedDocument(title: string, text: string) {
    return this.vec(`${title} ${text}`);
  }
  async embedQuery(query: string) {
    return this.vec(query);
  }
  async close() {}
}

export interface LlamaEmbedderOptions {
  uri: string;
  modelsDir: string;
  queryFormat: string; // contains {q}
  docFormat: string; // contains {title} and {text}
  contextSize?: number;
}

export const EMBEDDINGGEMMA: Omit<LlamaEmbedderOptions, "modelsDir"> = {
  uri: "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
  queryFormat: "task: search result | query: {q}",
  docFormat: "title: {title} | text: {text}",
};

/**
 * Embedding input that fits the context: chunks are cut by characters, and text that tokenizes
 * densely (OCR noise, non-Latin scripts, tables of numbers) can exceed the context, which makes
 * node-llama-cpp throw. Keeps the first tokens; a few are left free for special tokens.
 */
export function fitToContext(
  model: import("node-llama-cpp").LlamaModel,
  text: string,
  contextSize: number,
): import("node-llama-cpp").Token[] {
  const tokens = model.tokenize(text);
  const max = contextSize - 8;
  return tokens.length > max ? tokens.slice(0, max) : tokens;
}

/** GGUF embedding model through node-llama-cpp (Vulkan on the PC). Loaded lazily. */
export class LlamaEmbedder implements Embedder {
  private constructor(
    readonly spec: EmbeddingSpec,
    private opts: LlamaEmbedderOptions,
    private model: import("node-llama-cpp").LlamaModel,
    private ctx: import("node-llama-cpp").LlamaEmbeddingContext,
  ) {}

  static async load(opts: LlamaEmbedderOptions): Promise<LlamaEmbedder> {
    const { getLlama, resolveModelFile } = await import("node-llama-cpp");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(opts.modelsDir, { recursive: true });
    const llama = await getLlama({ gpu: "auto" });
    const modelPath = await resolveModelFile(opts.uri, { directory: opts.modelsDir, cli: false });
    const model = await llama.loadModel({ modelPath });
    const ctx = await model.createEmbeddingContext({ contextSize: opts.contextSize ?? 2048 });
    const dims = (await ctx.getEmbeddingFor("dimension probe")).vector.length;
    const spec: EmbeddingSpec = {
      model: opts.uri,
      dims,
      queryFormat: opts.queryFormat,
      docFormat: opts.docFormat,
      chunkTokens: CHUNK_TOKENS,
      overlapTokens: OVERLAP_TOKENS,
    };
    return new LlamaEmbedder(spec, opts, model, ctx);
  }

  async embedDocument(title: string, text: string) {
    const input = this.opts.docFormat.replace("{title}", title || "none").replace("{text}", text);
    return normalize((await this.ctx.getEmbeddingFor(fitToContext(this.model, input, this.contextSize))).vector);
  }
  async embedQuery(query: string) {
    const input = this.opts.queryFormat.replace("{q}", query);
    return normalize((await this.ctx.getEmbeddingFor(fitToContext(this.model, input, this.contextSize))).vector);
  }
  private get contextSize() {
    return this.opts.contextSize ?? 2048;
  }
  async close() {
    await this.ctx.dispose();
    await this.model.dispose();
  }
}
