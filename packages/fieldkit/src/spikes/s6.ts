import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { FieldkitConfig } from "../config.ts";
import { round, type SpikeResult } from "../report.ts";
import { scoreRankings, type TestSet } from "../testset.ts";
import type { Doc } from "./s3.ts";

export const QMD_VERSION = "2.8.3";
const INDEX = "fieldkit-s6";
const COLLECTION = "s6";

function qmd(args: string[], timeoutMs: number) {
  // npx keeps qmd out of the repo's dependencies; a separate named index keeps it out of any
  // qmd index you already use.
  const r = spawnSync("npx", ["-y", `@tobilu/qmd@${QMD_VERSION}`, "--index", INDEX, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Pull document numbers out of qmd JSON output; files are exported as <n>.md. */
export function parseQmdJson(out: string): number[] {
  const start = out.indexOf("[");
  if (start < 0) return [];
  let rows: unknown[];
  try {
    rows = JSON.parse(out.slice(start)) as unknown[];
  } catch {
    return [];
  }
  const ids: number[] = [];
  for (const row of rows) {
    const s = JSON.stringify(row);
    const m = s.match(/(?:^|[\\/"])(\d+)\.md/);
    if (m) ids.push(Number(m[1]));
  }
  return [...new Set(ids)];
}

/**
 * S6: the qmd baseline. Exports the same extracted documents S3 used as Markdown, indexes them
 * with qmd's full pipeline (BM25 + vectors + expansion + rerank), and scores it on the test set.
 * This is the number our own pipeline has to beat.
 */
export async function s6(
  cfg: FieldkitConfig,
  testset: TestSet,
  evalDocs: { docs: Doc[] },
  log: (s: string) => void,
): Promise<Omit<SpikeResult, "id" | "title" | "ms">> {
  const dir = join(cfg.privateDir, "s6-qmd-docs");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  evalDocs.docs.forEach((d, i) => writeFileSync(join(dir, `${i}.md`), `# ${basename(d.path)}\n\n${d.text}\n`));

  log("  S6: indexing with qmd (first run downloads ~2 GB of models)");
  qmd(["collection", "remove", COLLECTION], 120_000);
  const add = qmd(["collection", "add", dir, "--name", COLLECTION], 30 * 60_000);
  if (add.code !== 0) throw new Error(`qmd collection add failed: ${(add.err || add.out).slice(-400)}`);
  const embed = qmd(["embed", "-c", COLLECTION, "--timeout", "0"], 4 * 60 * 60_000);
  if (embed.code !== 0) throw new Error(`qmd embed failed: ${(embed.err || embed.out).slice(-400)}`);

  const rankings: string[][] = [];
  const latencies: number[] = [];
  for (const [i, q] of testset.queries.entries()) {
    log(`  S6: query ${i + 1}/${testset.queries.length}`);
    const t0 = performance.now();
    const r = qmd(["query", q.q, "-c", COLLECTION, "--format", "json", "-n", "10"], 10 * 60_000);
    latencies.push(performance.now() - t0);
    rankings.push(parseQmdJson(r.out).map((id) => evalDocs.docs[id]?.path ?? ""));
  }
  rmSync(dir, { recursive: true, force: true });

  const s = scoreRankings(testset.queries, rankings);
  const medianMs = [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)] ?? 0;
  return {
    verdict: "INFO",
    summary: `qmd ${QMD_VERSION}: recall@5 ${round(s.recallAtK * 100)}%, MRR ${round(s.mrr, 2)} over ${testset.queries.length} queries (median ${Math.round(medianMs / 1000)} s per CLI call, includes model load)`,
    data: { qmdVersion: QMD_VERSION, files: evalDocs.docs.length, recallAt5: round(s.recallAtK, 3), mrr: round(s.mrr, 3), perQuery: s.perQuery, medianCliMs: Math.round(medianMs) },
  };
}
