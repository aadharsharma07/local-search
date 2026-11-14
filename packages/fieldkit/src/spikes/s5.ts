import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FieldkitConfig } from "../config.ts";
import { indexable, sample, type Corpus, type CorpusFile } from "../corpus.ts";
import { quantile, round, type SpikeResult } from "../report.ts";
import type { ExtractResult, WorkerClient } from "@local-search/daemon/shared/worker";

const MIN_USABLE = 0.9; // share of sampled files with usable text
const MIN_CHARS = 40;

/** Rough text quality: share of tokens that look like real words or numbers. */
export function wordiness(text: string): number {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  const good = tokens.filter((t) => /^[\p{L}\p{N}][\p{L}\p{N}.,:;'’$%/()-]*$/u.test(t) && t.length <= 30);
  return good.length / tokens.length;
}

/** Code and notes only need to be readable; prose from PDFs and OCR must also look like words. */
const usable = (r: ExtractResult, group: string) =>
  r.ok && r.chars >= MIN_CHARS && (group === "text" || wordiness(r.text) >= 0.6);

function pick(c: Corpus, cfg: FieldkitConfig): Record<string, CorpusFile[]> {
  const files = indexable(c, cfg.maxFileBytes);
  return {
    pdf: sample(files.filter((f) => f.ext === ".pdf"), cfg.s5Sample.pdf),
    image: sample(files.filter((f) => f.kind === "image"), cfg.s5Sample.image),
    docx: sample(files.filter((f) => f.ext === ".docx"), cfg.s5Sample.docx),
    text: sample(files.filter((f) => f.kind === "text" || f.kind === "code"), cfg.s5Sample.text),
  };
}

/**
 * S5: extraction and OCR quality on a sample of real files. Compares every available OCR
 * engine on images and scanned PDF pages. Writes a private side-by-side review file that
 * stays on this machine; the report gets numbers only.
 */
export async function s5(
  cfg: FieldkitConfig,
  corpus: Corpus,
  worker: WorkerClient,
  log: (s: string) => void,
): Promise<Omit<SpikeResult, "id" | "title" | "ms">> {
  const engines = (await worker.engines()).ocr;
  const groups = pick(corpus, cfg);
  const review: string[] = ["# S5 private review (stays on this PC)", ""];
  const byGroup: Record<string, unknown> = {};
  let usableN = 0;
  let total = 0;
  const charsPerKind: Record<string, number> = {};

  for (const [group, files] of Object.entries(groups)) {
    const runs = group === "image" || group === "pdf" ? engines : ["auto"];
    const perEngine: Record<string, unknown> = {};
    for (const engine of runs.length ? runs : ["auto"]) {
      log(`  S5: ${group} × ${engine} (${files.length} files)`);
      const results: ExtractResult[] = [];
      for (const f of files) {
        const r = await worker.extract(f.path, engine);
        results.push(r);
        review.push(`## ${group} · ${engine} · ${f.path}`, "", r.ok ? "```\n" + r.text.slice(0, 400) + "\n```" : `FAILED: ${r.error}`, "");
      }
      const ok = results.filter((r) => r.ok);
      const u = results.filter((r) => usable(r, group)).length;
      perEngine[engine] = {
        files: results.length,
        ok: ok.length,
        usable: u,
        usableRate: results.length ? round(u / results.length, 3) : null,
        msP50: Math.round(quantile(results.map((r) => r.ms), 0.5)),
        msP95: Math.round(quantile(results.map((r) => r.ms), 0.95)),
        charsP50: Math.round(quantile(ok.map((r) => r.chars), 0.5)),
        ocrPages: results.reduce((n, r) => n + r.pages.filter((p) => p.method.startsWith("ocr:")).length, 0),
        errors: [...new Set(results.filter((r) => !r.ok).map((r) => (r.error ?? "").split(":")[0]))],
      };
      // Photos usually contain no text, so images are reported but do not count toward the
      // verdict; the OCR engine comparison is what matters for them.
      if ((engine === runs[0] || runs.length === 0) && group !== "image") {
        usableN += u;
        total += results.length;
      }
      if (engine === runs[0] || runs.length === 0) {
        charsPerKind[group] = Math.round(quantile(ok.map((r) => r.chars), 0.5)) || 0;
      }
    }
    byGroup[group] = perEngine;
  }

  // Index size estimate: census counts × median extracted chars, ~3600 chars per chunk.
  const idx = indexable(corpus, cfg.maxFileBytes);
  const count = (pred: (f: CorpusFile) => boolean) => idx.filter(pred).length;
  const estChunks = Math.round(
    (count((f) => f.ext === ".pdf") * (charsPerKind.pdf ?? 0) +
      count((f) => f.kind === "image") * (charsPerKind.image ?? 0) +
      count((f) => f.ext === ".docx") * (charsPerKind.docx ?? 0) +
      count((f) => f.kind === "text" || f.kind === "code") * (charsPerKind.text ?? 0)) /
      3060,
  );

  mkdirSync(cfg.privateDir, { recursive: true });
  const reviewPath = join(cfg.privateDir, `s5-review-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(reviewPath, review.join("\n"));

  const rate = total ? usableN / total : 0;
  return {
    verdict: total === 0 ? "SKIP" : rate >= MIN_USABLE ? "PASS" : "FAIL",
    summary: `${round(rate * 100)}% of ${total} sampled documents and text files gave usable text (need ≥${MIN_USABLE * 100}); OCR engines: ${engines.join(", ") || "none"}; est. ${estChunks.toLocaleString("en-US")} chunks for the full index`,
    data: { engines, groups: byGroup, medianCharsPerKind: charsPerKind, estimatedChunks: estChunks, workerRestarts: worker.restarts, privateReview: "written locally, not included" },
  };
}
