#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { bench, writeBench } from "./bench.ts";
import { CONFIG_PATH, DATA_DIR, defaultPython, loadDaemonConfig, REPO_ROOT, type DaemonConfig } from "./config.ts";
import { appendTests, suggestTests, why } from "./diagnose.ts";
import { deepSearch, loadExpander, loadReranker } from "./embed/extras.ts";
import { installStartup, removeStartup } from "./startup.ts";
import { Indexer, startServer, writeToken } from "./serve.ts";
import { loadTestSet } from "./shared/testset.ts";
import { openDb } from "./db/index.ts";
import { EMBEDDINGGEMMA, HashEmbedder, LlamaEmbedder, type Embedder } from "./embed/index.ts";
import { processQueue, scan, stateCounts } from "./ingest/index.ts";
import { search, type SearchOptions } from "./search/index.ts";
import { WorkerClient } from "./shared/worker.ts";

const HELP = `lsd — local-search daemon

Usage:
  lsd index [--roots a,b] [--exclude x,y] [--embedder gemma|hash]
                                                     Scan folders and index new or changed files
  lsd search "<query>" [-n 10] [--explain]          Hybrid keyword + vector + filename search
  lsd status                                         File counts by state
  lsd serve                                          Long-running: localhost API + background indexing
  lsd bench [--testset <file>] [--out <dir>] [--with-feedback]
                                                     Score the index against the test set
  lsd why "<query>" <path>                           Why a file did or didn't come back (terminal only)
  lsd testset suggest [--testset <file>]             Turn searches you opened results for into test entries
  lsd startup install|remove                         Start lsd serve hidden at Windows logon

Options:
  --db <file>        Index file (default: ~/.local-search/index.sqlite)
  --embedder <name>  gemma (default; runs a model, use on the PC) or hash (no model, keyword-level)
  --ocr <engine>     auto (default), windows, rapidocr, tesseract, or none (skip OCR entirely)
  --exclude <names>  Extra folder names to skip anywhere, added to the built-in list
  --with-feedback    Let files opened for past searches boost results (bench ignores them by default)

Settings (roots, excludeDirs, rerank, expand, port, deepSearch, hotkey) are read from ${CONFIG_PATH}.
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
      "with-feedback": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) return console.log(HELP);

  mkdirSync(DATA_DIR, { recursive: true });

  if (cmd === "startup") {
    const [action] = rest;
    if (action === "install") console.log(`Installed: ${installStartup(REPO_ROOT, DATA_DIR)}\nlsd serve starts at your next logon (log: ${join(DATA_DIR, "daemon.log")}).`);
    else if (action === "remove") console.log(removeStartup() ? "Removed." : "Not installed.");
    else throw new Error("Usage: lsd startup install|remove");
    return;
  }

  const db = openDb(values.db ?? join(DATA_DIR, "index.sqlite"));

  if (cmd === "why") {
    const [q, path] = rest;
    if (!q || !path) throw new Error('Usage: lsd why "<query>" <path>');
    const embedder = await makeEmbedder(values.embedder!);
    const r = await why(db, embedder, q, resolve(path));
    await embedder.close();
    if (!r.file) console.log("Not in the index (outside the roots, excluded, or not scanned yet).");
    else {
      console.log(`File: ${r.file.state} · ${r.file.kind}${r.file.skipReason ? ` · skipped: ${r.file.skipReason}` : ""}${r.file.error ? ` · error: ${r.file.error}` : ""}`);
      console.log(r.content ? `Text: ${r.content.chars} chars · ${r.content.words} words · ${r.content.chunks} chunks · ${r.content.extractor}` : "Text: none extracted");
      console.log(r.position ? `Ranked #${r.position} (score ${r.score}, top ${r.topScore})` : "Not retrieved by any list in the top 200.");
      if (r.trace) console.log(`Lists: ${JSON.stringify(r.trace)}`);
    }
    return;
  }

  if (cmd === "testset" && rest[0] === "suggest") {
    const file = values.testset ?? join(DATA_DIR, "testset.json");
    const existing = existsSync(file) ? loadTestSet(file).queries : [];
    const all = suggestTests(db, existing);
    if (!all.length) return console.log("No new suggestions: open some results from the popup first.");
    if (!existsSync(file)) writeFileSync(file, JSON.stringify({ queries: [] }, null, 2));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const keep: typeof all = [];
    try {
      for (const s of all) {
        const a = (await rl.question(`"${s.q}" → ${s.path} (opened ${s.opens}x). Add? [y/N/q] `)).trim().toLowerCase();
        if (a === "q") break;
        if (a === "y") keep.push(s);
      }
    } finally {
      rl.close();
    }
    console.log(`Added ${appendTests(file, keep)} to ${file}.`);
    return;
  }

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
    const r = await bench(db, embedder, t, { withFeedback: values["with-feedback"] });
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
    // "Search harder" loads real models, so it is off with the model-free hash embedder (Mac dev).
    const deepLoader = cfg.deepSearch && values.embedder !== "hash" ? deepSearch(join(DATA_DIR, "models")) : null;
    const deep = deepLoader
      ? async () => {
          if (!deepLoader.loaded) log("search harder: loading reranker and expander");
          return deepLoader.get();
        }
      : undefined;
    const indexer = new Indexer({ db, worker, embedder, cfg, log });
    const token = writeToken();
    const popup = { roots: cfg.roots, hotkey: cfg.hotkey };
    const { server, port } = await startServer({ db, embedder, token, port: cfg.port, indexer, searchOpts, deep, popup });
    log(
      `listening on http://127.0.0.1:${port} · token in ${join(DATA_DIR, "token")} · rerank ${cfg.rerank ? "on" : "off"} · ` +
        `expand ${cfg.expand ? "on" : "off"} · search harder ${deep ? "on demand" : "off"}`,
    );
    indexer.start();
    const shutdown = async () => {
      indexer.stop();
      server.close();
      worker.close();
      await deepLoader?.close();
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
