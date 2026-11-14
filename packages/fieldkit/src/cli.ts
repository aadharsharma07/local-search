#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, REPO_ROOT, type FieldkitConfig } from "./config.ts";
import { scanCorpus, type Corpus } from "./corpus.ts";
import { newReport, timed, writeReport, type SpikeResult } from "./report.ts";
import { census } from "./spikes/census.ts";
import { s1 } from "./spikes/s1.ts";
import { s2 } from "./spikes/s2.ts";
import { buildEvalDocs, s3, type Doc } from "./spikes/s3.ts";
import { s4 } from "./spikes/s4.ts";
import { s5 } from "./spikes/s5.ts";
import { s6 } from "./spikes/s6.ts";
import { loadTestSet, type TestSet } from "./testset.ts";
import { WorkerClient } from "@local-search/daemon/shared/worker";

const HELP = `fieldkit — measurements for the local-search PC (see docs/FIELD-VISIT.md)

Usage:
  fieldkit run [--skip s2,s6] [--fixtures]   Run everything and write a report
  fieldkit census | s1 | s2 | s3 | s4 | s5 | s6
  fieldkit testset init                      Create a test set template to fill in
  fieldkit testset check                     Validate the test set

Options:
  --config <file>     Config file (default: fieldkit.yaml in the repo root)
  --testset <file>    Test set (default: ~/.local-search/testset.json)
  --fixtures          Use the synthetic fixture corpus instead of your folders (dev mode)
  --skip <ids>        Comma-separated spikes to skip
  --quick             Smaller S2 run (100 chunks)
`;

// Run order matters: S5 estimates the index size that S2 turns into an overnight-index estimate.
const SPIKES = {
  census: "Corpus census",
  s1: "Native dependencies load",
  s5: "Extraction and OCR quality",
  s2: "GPU speed",
  s3: "Embedding model comparison",
  s4: "Laya facet routing",
  s6: "qmd baseline",
} as const;
type SpikeId = keyof typeof SPIKES;

const log = (s: string) => console.error(s);

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      testset: { type: "string" },
      fixtures: { type: "boolean", default: false },
      skip: { type: "string", default: "" },
      quick: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, sub] = positionals;
  if (values.help || !cmd) {
    console.log(HELP);
    return;
  }

  const cfg: FieldkitConfig = loadConfig(values.config);
  if (values.fixtures) {
    cfg.roots = ["Downloads", "Documents", "Pictures", "Code"].map((d) => join(REPO_ROOT, "fixtures", "corpus", d));
    cfg.testsetPath = join(REPO_ROOT, "fixtures", "queries.json");
    cfg.s3Distractors = 0;
  }
  if (values.testset) cfg.testsetPath = values.testset;

  if (cmd === "testset") return testsetCmd(cfg, sub);

  const wanted: SpikeId[] =
    cmd === "run" ? (Object.keys(SPIKES) as SpikeId[]) : cmd in SPIKES ? [cmd as SpikeId] : [];
  if (!wanted.length) {
    console.error(`Unknown command: ${cmd}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  const skip = new Set(values.skip.split(",").map((s) => s.trim()).filter(Boolean));
  const ids = wanted.filter((id) => !skip.has(id));

  const report = newReport();
  const worker = new WorkerClient(cfg.python, cfg.extractTimeoutMs);
  let corpus: Corpus | null = null;
  let testset: TestSet | null = null;
  let evalDocs: { docs: Doc[]; failed: number } | null = null;

  const needCorpus = ids.some((id) => ["census", "s3", "s5", "s6"].includes(id));
  if (needCorpus) {
    log(`Scanning ${cfg.roots.length} folders…`);
    corpus = await scanCorpus(cfg, worker);
    log(`  ${corpus.files.length} files`);
  }
  const getTestset = () => (testset ??= loadTestSet(cfg.testsetPath, values.fixtures ? join(REPO_ROOT, "fixtures", "corpus") : undefined));
  const getEvalDocs = async () => {
    if (!evalDocs) {
      log("Extracting test-set files and distractors…");
      evalDocs = await buildEvalDocs(cfg, getTestset(), corpus, worker, log);
    }
    return evalDocs;
  };

  const runners: Record<SpikeId, () => Promise<Omit<SpikeResult, "id" | "title" | "ms">>> = {
    census: () => census(cfg, corpus!),
    s1: () => s1(cfg),
    s2: () => {
      const est = report.results.find((r) => r.id === "s5")?.data.estimatedChunks;
      return s2(cfg, { chunks: values.quick ? 100 : 300, estimatedChunks: typeof est === "number" ? est : undefined });
    },
    s3: async () => s3(cfg, getTestset(), await getEvalDocs(), log),
    s4: () => s4(),
    s5: () => s5(cfg, corpus!, worker, log),
    s6: async () => s6(cfg, getTestset(), await getEvalDocs(), log),
  };

  for (const id of ids) {
    log(`\n▶ ${id}: ${SPIKES[id]}`);
    const r = await timed(id, SPIKES[id], runners[id]);
    report.results.push(r);
    log(`  ${r.verdict} — ${r.summary}`);
  }
  worker.close();

  const out = writeReport(report, values.fixtures ? join(REPO_ROOT, "fieldkit-out", "fixtures") : cfg.outDir);
  log(`\nReport: ${out.md}\n        ${out.json}`);
  if (report.results.some((r) => r.verdict === "FAIL")) process.exitCode = 1;
}

function testsetCmd(cfg: FieldkitConfig, sub?: string) {
  if (sub === "init") {
    if (existsSync(cfg.testsetPath)) {
      console.log(`Test set already exists: ${cfg.testsetPath}`);
      return;
    }
    mkdirSync(dirname(cfg.testsetPath), { recursive: true });
    const template = {
      about:
        "Your private test set. Write 20-30 searches you would really type, each with the file(s) that should come back. Paths may be absolute or relative to root. This file never leaves this PC.",
      root: dirname(dirname(cfg.testsetPath)),
      queries: [
        { q: "where did I buy that office chair", expected: ["Downloads\\example-receipt.pdf"] },
        { q: "my 2023 tax return", expected: ["Documents\\Taxes\\2023.pdf"] },
      ],
    };
    writeFileSync(cfg.testsetPath, JSON.stringify(template, null, 2));
    console.log(`Created ${cfg.testsetPath}. Fill it in, then run: fieldkit testset check`);
    return;
  }
  if (sub === "check") {
    const t = loadTestSet(cfg.testsetPath);
    const n = t.queries.length;
    console.log(`${n} queries, ${t.queries.reduce((a, q) => a + q.expected.length, 0)} expected files.`);
    if (t.missing.length) {
      console.log(`Missing files (${t.missing.length}):`);
      for (const m of t.missing) console.log(`  ${m}`);
      process.exitCode = 1;
    } else if (n < 20) {
      console.log("All files found. Add more queries: aim for 20-30.");
    } else {
      console.log("All files found. Ready.");
    }
    return;
  }
  console.log("Usage: fieldkit testset init | check");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
