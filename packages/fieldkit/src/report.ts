import { mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, homedir, platform, release, totalmem } from "node:os";
import { join } from "node:path";

export type Verdict = "PASS" | "FAIL" | "SKIP" | "INFO";

export interface SpikeResult {
  id: string; // census, s1..s6
  title: string;
  verdict: Verdict;
  /** One line a person reads first. */
  summary: string;
  /** Aggregate numbers only. Never file names, paths or file contents. */
  data: Record<string, unknown>;
  ms: number;
}

export interface Report {
  version: 1;
  createdAt: string;
  machine: { platform: string; release: string; arch: string; cpu: string; cores: number; ramGb: number; node: string };
  results: SpikeResult[];
}

export function newReport(): Report {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    machine: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
      cores: cpus().length,
      ramGb: Math.round(totalmem() / 1024 ** 3),
      node: process.version,
    },
    results: [],
  };
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i]!;
}

export const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

/** Like round(), but keeps small values readable (0.042 instead of 0). */
export const nice = (x: number) => (x !== 0 && Math.abs(x) < 1 ? Number(x.toPrecision(2)) : round(x));

export async function timed(
  id: string,
  title: string,
  fn: () => Promise<Omit<SpikeResult, "id" | "title" | "ms">>,
): Promise<SpikeResult> {
  const t0 = performance.now();
  try {
    const r = await fn();
    return { id, title, ...r, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return {
      id, title, verdict: "FAIL", summary: `Crashed: ${(e as Error).message}`,
      data: { error: String((e as Error).stack ?? e).slice(0, 2000) }, ms: Math.round(performance.now() - t0),
    };
  }
}

/**
 * Replace the home folder (which contains the Windows user name) with ~ everywhere in a
 * serialized report: error messages and crash logs can contain full paths.
 */
export function redactHome(text: string, home = homedir()): string {
  if (!home || home.length < 3) return text;
  const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Raw, forward-slash and JSON-escaped spellings, matched case-insensitively (Windows paths).
  const forms = [...new Set([home, home.replace(/\\/g, "/"), JSON.stringify(home).slice(1, -1)])].sort((a, b) => b.length - a.length);
  return text.replace(new RegExp(forms.map(escape).join("|"), "gi"), "~");
}

export function writeReport(report: Report, outDir: string): { json: string; md: string } {
  const stamp = report.createdAt.replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(outDir, stamp);
  mkdirSync(dir, { recursive: true });
  const json = join(dir, "report.json");
  const md = join(dir, "summary.md");
  writeFileSync(json, redactHome(JSON.stringify(report, null, 2)));
  const m = report.machine;
  const lines = [
    `# Field kit report — ${report.createdAt.slice(0, 16).replace("T", " ")}`,
    "",
    `${m.platform} ${m.release} · ${m.cpu} (${m.cores} threads) · ${m.ramGb} GB RAM · Node ${m.node}`,
    "",
    "| Spike | Verdict | Summary | Time |",
    "|---|---|---|---|",
    ...report.results.map((r) => `| ${r.id} ${r.title} | **${r.verdict}** | ${r.summary.replace(/\|/g, "/")} | ${round(r.ms / 1000)} s |`),
    "",
    "Full numbers are in report.json. This report contains aggregate numbers only: no file names, paths or contents.",
  ];
  writeFileSync(md, redactHome(lines.join("\n") + "\n"));
  return { json, md };
}
