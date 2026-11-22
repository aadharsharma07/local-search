#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { bench, writeBench } from "./bench.ts";
import { CONFIG_PATH, DATA_DIR, defaultPython, loadDaemonConfig, REPO_ROOT, type DaemonConfig } from "./config.ts";
import { loadExpander, loadReranker } from "./embed/extras.ts";
import { Indexer, startServer, writeToken } from "./serve.ts";
import { loadTestSet } from "./shared/testset.ts";
import { openDb } from "./db/index.ts";
import { EMBEDDINGGEMMA, HashEmbedder, LlamaEmbedder, type Embedder } from "./embed/index.ts";
import { processQueue, scan, stateCounts } from "./ingest/index.ts";
import { search, type SearchOptions } from "./search/index.ts";
import { WorkerClient } from "./shared/worker.ts";

const HELP = `lsd — local-search daemon (Sprint 1: command line only)

Usage:
  lsd index [--roots a,b] [--exclude x,y] [--embedder gemma|hash]
                                                     Scan folders and index new or changed files
  lsd search "<query>" [-n 10] [--explain]          Hybrid keyword + vector + filename search
  lsd status                                         File counts by state
  lsd serve                                          Long-running: localhost API + background indexing
  lsd bench [--testset <file>] [--out <dir>]         Score the index against the test set

Options:
  --db <file>        Index file (default: ~/.local-search/index.sqlite)
  --embedder <name>  gemma (default; runs a model, use on the PC) or hash (no model, keyword-level)
  --ocr <engine>     auto (default), windows, rapidocr, tesseract, or none (skip OCR entirely)
  --exclude <names>  Extra folder names to skip anywhere, added to the built-in list

Settings (roots, excludeDirs, rerank, expand, port) are read from ${CONFIG_PATH}.
`;

/** Reranker and expander, loaded only when switched on in the config. */
async function loadExtras(cfg: DaemonConfig): Promise<Pick<SearchOptions, "rerank" | "expand">> {
  const dir = join(DATA_DIR, "models");
  return {
    ...(cfg.rerank ? { rerank: await loadReranker(dir) } : {}),
    ...(cfg.expand ? { expand: await loadExpander(dir) } : {}),
  };
}

async function makeEmbedder(name: string): Promise<Embedder> {
  if (name === "hash") return new HashEmbedder();
  if (name === "gemma") return LlamaEmbedder.load({ ...EMBEDDINGGEMMA, modelsDir: join(DATA_DIR, "models") });
  throw new Error(`Unknown embedder ${name}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      db: { type: "string" },
      roots: { type: "string" },
      exclude: { type: "string" },
      embedder: { type: "string", default: "gemma" },
      n: { type: "string", short: "n", default: "10" },
      explain: { type: "boolean", default: false },
      testset: { type: "string" },
      out: { type: "string" },
      ocr: { type: "string", default: "auto" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) return console.log(HELP);

  mkdirSync(DATA_DIR, { recursive: true });
  const db = openDb(values.db ?? join(DATA_DIR, "index.sqlite"));

  if (cmd === "status") {
    console.table(stateCounts(db));
    return;
  }

  if (cmd === "index") {
    const cfg = loadDaemonConfig();
    const roots = values.roots ? values.roots.split(",") : cfg.roots;
    const worker = new WorkerClient(defaultPython(), 60_000);
    const cloudCheck = process.platform === "win32" ? (paths: string[]) => worker.cloudCheck(paths) : undefined;
    const extra = values.exclude ? values.exclude.split(",").map((d) => d.trim()).filter(Boolean) : [];
    const s = await scan(db, { roots, excludeDirs: [...cfg.excludeDirs, ...extra], cloudCheck });
    console.error(`scan: ${s.seen} files · ${s.added} new · ${s.changed} changed · ${s.restored} restored · ${s.tombstoned} removed · ${s.skipped} skipped`);
    if (s.missingRoots.length) console.error(`missing folders (left untouched): ${s.missingRoots.join(", ")}`);
    const embedder = await makeEmbedder(values.embedder!);
    let n = 0;
    const r = await processQueue(db, {
      worker,
      embedder,
      ocr: values.ocr,
      onFile: () => {
        if (++n % 25 === 0) console.error(`  ${n} files processed`);
      },
    });
    console.error(`index: ${r.indexed} indexed · ${r.linked} duplicates linked · ${r.failed} failed · ${r.reembedded} chunks re-embedded`);
    await embedder.close();
    worker.close();
    return;
  }

  if (cmd === "bench") {
    const t = loadTestSet(values.testset ?? join(DATA_DIR, "testset.json"));
    const embedder = await makeEmbedder(values.embedder!);
    const r = await bench(db, embedder, t);
    await embedder.close();
    const dir = writeBench(r, values.out ?? join(REPO_ROOT, "reports"));
    console.log(`recall@5 ${Math.round(r.recallAt5 * 1000) / 10}% · MRR ${r.mrr} · ${r.queries.inScope}/${r.queries.total} queries in scope · p50 ${r.latencyMs.p50} ms`);
    console.error(`Report: ${dir}`);
    return;
  }

  if (cmd === "serve") {
    const cfg = loadDaemonConfig();
    const log = (m: string) => console.error(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);
    const worker = new WorkerClient(defaultPython(), 60_000);
    log("loading models (kept loaded while serving)");
    const embedder = await makeEmbedder(values.embedder!);
    const searchOpts = await loadExtras(cfg);
    const indexer = new Indexer({ db, worker, embedder, cfg, log });
    const token = writeToken();
    const { server, port } = await startServer({ db, embedder, token, port: cfg.port, indexer, searchOpts });
    log(`listening on http://127.0.0.1:${port} · token in ${join(DATA_DIR, "token")} · rerank ${cfg.rerank ? "on" : "off"} · expand ${cfg.expand ? "on" : "off"}`);
    indexer.start();
    const shutdown = async () => {
      indexer.stop();
      server.close();
      worker.close();
      await embedder.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    return;
  }

  if (cmd === "search") {
    const q = rest.join(" ");
    if (!q) throw new Error('Usage: lsd search "<query>"');
    const embedder = await makeEmbedder(values.embedder!);
    const extras = await loadExtras(loadDaemonConfig());
    const t0 = performance.now();
    const hits = await search(db, embedder, q, { limit: Number(values.n), ...extras });
    const ms = Math.round(performance.now() - t0);
    hits.forEach((h, i) => {
      const dup = h.paths.length > 1 ? ` (+${h.paths.length - 1} duplicate${h.paths.length > 2 ? "s" : ""})` : "";
      console.log(`${i + 1}. ${h.paths[0]}${h.page ? ` p.${h.page}` : ""}${dup}`);
      if (h.snippet) console.log(`   ${h.snippet}`);
      if (values.explain) console.log(`   score ${h.score} ${JSON.stringify(h.trace)}`);
    });
    console.error(`${hits.length} results in ${ms} ms`);
    await embedder.close();
    return;
  }

  console.error(HELP);
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
