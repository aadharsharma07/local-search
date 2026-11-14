import { mkdirSync } from "node:fs";
import { getLlama, resolveModelFile, type Llama, type LlamaModel } from "node-llama-cpp";

export interface EmbeddingCandidate {
  id: string;
  uri: string;
  approxMb: number;
  query: (q: string) => string;
  doc: (title: string, text: string) => string;
}

/** Embedding models compared in S3. Prompt formats follow each model card. */
export const EMBEDDERS: EmbeddingCandidate[] = [
  {
    id: "embeddinggemma-300m",
    uri: "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
    approxMb: 330,
    query: (q) => `task: search result | query: ${q}`,
    doc: (title, text) => `title: ${title || "none"} | text: ${text}`,
  },
  {
    id: "qwen3-embedding-0.6b",
    uri: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
    approxMb: 640,
    query: (q) =>
      `Instruct: Given a search query, retrieve the personal file that answers it\nQuery: ${q}`,
    doc: (title, text) => `${title}\n${text}`,
  },
  {
    id: "nomic-embed-text-v1.5",
    uri: "hf:nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.Q8_0.gguf",
    approxMb: 145,
    query: (q) => `search_query: ${q}`,
    doc: (title, text) => `search_document: ${title}\n${text}`,
  },
];

export const RERANKER_URI = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";

let llamaPromise: Promise<Llama> | null = null;
/** One llama.cpp instance per process; picks Vulkan on the PC, Metal on the Mac. */
export function llama(): Promise<Llama> {
  llamaPromise ??= getLlama({ gpu: "auto" });
  return llamaPromise;
}

export async function loadModel(uri: string, modelsDir: string): Promise<LlamaModel> {
  mkdirSync(modelsDir, { recursive: true });
  const path = await resolveModelFile(uri, { directory: modelsDir, cli: false });
  return (await llama()).loadModel({ modelPath: path });
}

export async function gpuInfo() {
  const l = await llama();
  const vram = await l.getVramState();
  return {
    backend: l.gpu || "cpu",
    devices: await l.getGpuDeviceNames(),
    vramTotalGb: Math.round((vram.total / 1024 ** 3) * 10) / 10,
    vramFreeGb: Math.round((vram.free / 1024 ** 3) * 10) / 10,
  };
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
