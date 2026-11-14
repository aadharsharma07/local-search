#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DATA_DIR, DEFAULT_EXCLUDES, defaultPython, defaultRoots } from "./config.ts";
import { openDb } from "./db/index.ts";
import { EMBEDDINGGEMMA, HashEmbedder, LlamaEmbedder, type Embedder } from "./embed/index.ts";
import { processQueue, scan, stateCounts } from "./ingest/index.ts";
import { search } from "./search/index.ts";
import { WorkerClient } from "./shared/worker.ts";

const HELP = `lsd — local-search daemon (Sprint 1: command line only)

Usage:
  lsd index [--roots a,b] [--embedder gemma|hash]   Scan folders and index new or changed files
  lsd search "<query>" [-n 10] [--explain]          Hybrid keyword + vector + filename search
  lsd status                                         File counts by state

Options:
  --db <file>        Index file (default: ~/.local-search/index.sqlite)
  --embedder <name>  gemma (default; runs a model, use on the PC) or hash (no model, keyword-level)
`;

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
      embedder: { type: "string", default: "gemma" },
      n: { type: "string", short: "n", default: "10" },
      explain: { type: "boolean", default: false },
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
    const roots = values.roots ? values.roots.split(",") : defaultRoots();
    const worker = new WorkerClient(defaultPython(), 60_000);
    const cloudCheck =
      process.platform === "win32"
        ? async (paths: string[]) => {
            const hits = new Set<number>();
            for (let i = 0; i < paths.length; i += 5000) {
              const r = await worker.request<{ placeholders: number[] }>({ op: "cloudattrs", paths: paths.slice(i, i + 5000) }, 300_000);
              for (const j of r.placeholders) hits.add(i + j);
            }
            return hits;
          }
        : undefined;
    const s = await scan(db, { roots, excludeDirs: DEFAULT_EXCLUDES, cloudCheck });
    console.error(`scan: ${s.seen} files · ${s.added} new · ${s.changed} changed · ${s.restored} restored · ${s.tombstoned} removed · ${s.skipped} skipped`);
    if (s.missingRoots.length) console.error(`missing folders (left untouched): ${s.missingRoots.join(", ")}`);
    const embedder = await makeEmbedder(values.embedder!);
    let n = 0;
    const r = await processQueue(db, {
      worker,
      embedder,
      onFile: () => {
        if (++n % 25 === 0) console.error(`  ${n} files processed`);
      },
    });
    console.error(`index: ${r.indexed} indexed · ${r.linked} duplicates linked · ${r.failed} failed · ${r.reembedded} chunks re-embedded`);
    await embedder.close();
    worker.close();
    return;
  }

  if (cmd === "search") {
    const q = rest.join(" ");
    if (!q) throw new Error('Usage: lsd search "<query>"');
    const embedder = await makeEmbedder(values.embedder!);
    const t0 = performance.now();
    const hits = await search(db, embedder, q, { limit: Number(values.n) });
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
