#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { s4b } from "./spikes/s4b.ts";
import { s7 } from "./spikes/s7.ts";
import { s5 } from "./spikes/s5.ts";
import { s6 } from "./spikes/s6.ts";
import { loadTestSet, type TestSet } from "@local-search/daemon/shared/testset";
import { WorkerClient } from "@local-search/daemon/shared/worker";

const HELP = `fieldkit — measurements for the local-search PC (see docs/FIELD-VISIT.md)

Usage:
  fieldkit run [--skip s6] [--fixtures]      Run everything and write a report
  fieldkit census | s1 | s5 | s2 | s3 | s4 | s4b | s7 | s6
  fieldkit testset init                      Create a test set template to fill in
  fieldkit testset check                     Validate the test set

Options:
  --config <file>     Config file (default: fieldkit.yaml in the repo root)
  --testset <file>    Test set (default: ~/.local-search/testset.json)
  --fixtures          Use the synthetic fixture corpus instead of your folders (dev mode)
  --skip <ids>        Comma-separated spikes to skip
  --only <ids>        Run only these spikes (safer than --skip when new spikes are added)
  --quick             Smaller S2 run (100 chunks)
  --fail-on <what>    fail (default): exit 1 on any FAIL; crash: only on a crashed spike
`;

// Run order matters: S5 estimates the index size that S2 turns into an overnight-index estimate.
const SPIKES = {
  census: "Corpus census",
  s1: "Native dependencies load",
  s5: "Extraction and OCR quality",
  s2: "GPU speed",
  s3: "Embedding model comparison",
  s4: "Laya facet routing",
  s4b: "Rules + embedding facet routing",
  s7: "Text generation speed",
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
      only: { type: "string", default: "" },
      quick: { type: "boolean", default: false },
      "fail-on": { type: "string", default: "fail" },
      "spike-timeout-min": { type: "string", default: "180" },
      // Internal: set by `run` when it starts a spike in a child process.
      "child-out": { type: "string" },
      "est-chunks": { type: "string" },
      pick: { type: "string" },
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
  const only = new Set(values.only.split(",").map((s) => s.trim()).filter(Boolean));
  const ids = wanted.filter((id) => !skip.has(id) && (only.size === 0 || only.has(id)));

  const outDir = values.fixtures ? join(REPO_ROOT, "fieldkit-out", "fixtures") : cfg.outDir;

  // `run`: every spike in its own child process, report rewritten after each one, so a native
  // crash (e.g. inside llama.cpp) loses only that spike, never the whole visit.
  if (cmd === "run" && !values["child-out"]) {
    const report = newReport();
    const forward = [
      ...(values.config ? ["--config", values.config] : []),
      ...(values.testset ? ["--testset", values.testset] : []),
      ...(values.fixtures ? ["--fixtures"] : []),
      ...(values.quick ? ["--quick"] : []),
    ];
    const tmp = mkdtempSync(join(tmpdir(), "fieldkit-"));
    for (const id of ids) {
      const est = report.results.find((r) => r.id === "s5")?.data.estimatedChunks;
      const pick = report.results.find((r) => r.id === "s3")?.data.pick;
      const extra = [
        ...(typeof est === "number" ? ["--est-chunks", String(est)] : []),
        ...(typeof pick === "string" ? ["--pick", pick] : []),
      ];
      const r = await runChild(id, [...forward, ...extra], join(tmp, `${id}.json`), Number(values["spike-timeout-min"]) * 60_000);
      report.results.push(r);
      if (r.summary.startsWith("Crashed")) log(`  ${r.verdict} — ${r.summary}`); // the child logs its own result otherwise
      writeReport(report, outDir);
    }
    rmSync(tmp, { recursive: true, force: true });
    return finish(report, outDir, values["fail-on"]!);
  }

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
  const quick = values.quick!;
  const estChunks = values["est-chunks"] ? Number(values["est-chunks"]) : undefined;

  const runners: Record<SpikeId, () => Promise<Omit<SpikeResult, "id" | "title" | "ms">>> = {
    census: () => census(cfg, corpus!),
    s1: () => s1(cfg),
    s2: () => s2(cfg, { chunks: quick ? 10 : 300, quick, estimatedChunks: estChunks, log }),
    s3: async () => s3(cfg, getTestset(), await getEvalDocs(), log),
    s4: () => s4({ testsetPath: cfg.testsetPath, limit: quick ? 8 : undefined }),
    s4b: () => s4b(cfg, { testsetPath: cfg.testsetPath, embedderId: values.pick }),
    s7: () => s7(cfg, { tokens: quick ? 16 : undefined }),
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

  if (values["child-out"]) {
    writeFileSync(values["child-out"], JSON.stringify(report.results[0] ?? null));
    return;
  }
  finish(report, outDir, values["fail-on"]!);
}

function finish(report: ReturnType<typeof newReport>, outDir: string, failOn: string) {
  const out = writeReport(report, outDir);
  log(`\nReport: ${out.md}\n        ${out.json}`);
  // --fail-on crash: only a crashed spike fails the run (CI dry runs on slow CPUs miss targets).
  const crashed = report.results.filter((r) => r.summary.startsWith("Crashed"));
  if (crashed.length) log(`Crashed: ${crashed.map((r) => r.id).join(", ")}`);
  const failing = failOn === "crash" ? crashed : report.results.filter((r) => r.verdict === "FAIL");
  if (failing.length) process.exitCode = 1;
}

/** Run one spike in a child process; a crash or timeout becomes a "Crashed" result. */
function runChild(id: SpikeId, args: string[], outFile: string, timeoutMs: number): Promise<SpikeResult> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, id, ...args, "--child-out", outFile], {
      stdio: ["ignore", "inherit", "pipe"],
    });
    let tail = "";
    child.stderr.on("data", (d: Buffer) => {
      process.stderr.write(d);
      tail = (tail + d.toString()).slice(-3000);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const ms = Math.round(performance.now() - t0);
      if (existsSync(outFile)) {
        const r = JSON.parse(readFileSync(outFile, "utf8")) as SpikeResult | null;
        if (r) return resolve({ ...r, ms });
      }
      const why = timedOut ? `timeout after ${Math.round(timeoutMs / 60000)} min` : `exit code ${code ?? signal}${code === 3221226356 ? " (heap corruption)" : ""}`;
      resolve({
        id, title: SPIKES[id], verdict: "FAIL", ms,
        summary: `Crashed: process ended (${why})`,
        data: { error: `child process ended: ${why}`, logTail: tail },
      });
    });
  });
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
