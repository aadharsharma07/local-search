import type { FieldkitConfig } from "../config.ts";
import { indexable, sample, type Corpus } from "../corpus.ts";
import { hostOf, readOrigin } from "../platform.ts";
import { round, type SpikeResult } from "../report.ts";

const SIZE_BUCKETS: [string, number][] = [
  ["<10KB", 10 * 1024],
  ["10-100KB", 100 * 1024],
  ["100KB-1MB", 1024 * 1024],
  ["1-10MB", 10 * 1024 * 1024],
  [">=10MB", Infinity],
];

/** Corpus census: how much there is to index. Aggregates only; no names or paths. */
export async function census(cfg: FieldkitConfig, corpus: Corpus): Promise<Omit<SpikeResult, "id" | "title" | "ms">> {
  const files = corpus.files;
  const byKind: Record<string, { files: number; mb: number }> = {};
  const byExt = new Map<string, { files: number; bytes: number }>();
  const bySize: Record<string, number> = Object.fromEntries(SIZE_BUCKETS.map(([k]) => [k, 0]));
  const byYear: Record<string, number> = {};
  const byRoot: Record<string, number> = {};
  let bytes = 0;
  let longPaths = 0;
  let nonAscii = 0;
  let maxDepth = 0;

  for (const f of files) {
    bytes += f.size;
    const k = (byKind[f.kind] ??= { files: 0, mb: 0 });
    k.files++;
    k.mb += f.size / 1024 ** 2;
    const e = byExt.get(f.ext || "(none)") ?? { files: 0, bytes: 0 };
    e.files++;
    e.bytes += f.size;
    byExt.set(f.ext || "(none)", e);
    bySize[SIZE_BUCKETS.find(([, lim]) => f.size < lim)![0]]!++;
    const year = String(new Date(f.mtimeMs).getFullYear());
    byYear[year] = (byYear[year] ?? 0) + 1;
    byRoot[f.root] = (byRoot[f.root] ?? 0) + 1;
    if (f.path.length >= 260) longPaths++;
    if (/[^\x00-\x7F]/.test(f.path)) nonAscii++;
    maxDepth = Math.max(maxDepth, f.depth);
  }
  for (const k of Object.values(byKind)) k.mb = round(k.mb);

  const topExt = [...byExt.entries()]
    .sort((a, b) => b[1].files - a[1].files)
    .slice(0, 30)
    .map(([ext, v]) => ({ ext, files: v.files, mb: round(v.bytes / 1024 ** 2) }));

  // Download origin coverage, measured on a sample of Downloads.
  const downloads = files.filter((f) => f.root.toLowerCase() === "downloads");
  const probe = sample(downloads, 300);
  let withOrigin = 0;
  let withHost = 0;
  for (const f of probe) {
    const o = readOrigin(f.path);
    if (!o) continue;
    withOrigin++;
    if (hostOf(o.hostUrl) ?? hostOf(o.referrerUrl)) withHost++;
  }

  const idx = indexable(corpus, cfg.maxFileBytes);
  const idxKinds: Record<string, number> = {};
  for (const f of idx) idxKinds[f.kind] = (idxKinds[f.kind] ?? 0) + 1;
  const cloud = files.filter((f) => f.cloud).length;

  const summary =
    `${files.length.toLocaleString("en-US")} files (${round(bytes / 1024 ** 3, 2)} GB) in ${corpus.rootsFound.length} folders; ` +
    `${idx.length.toLocaleString("en-US")} indexable in v1 (${Object.entries(idxKinds).map(([k, n]) => `${n} ${k}`).join(", ")})` +
    (cloud ? `; ${cloud} cloud-only` : "");

  return {
    verdict: "INFO",
    summary,
    data: {
      roots: { found: corpus.rootsFound, missing: corpus.rootsMissing, filesPerRoot: byRoot },
      totals: { files: files.length, gb: round(bytes / 1024 ** 3, 2) },
      indexable: { files: idx.length, byKind: idxKinds },
      byKind,
      topExtensions: topExt,
      sizeBuckets: bySize,
      overSizeLimit: files.filter((f) => f.size > cfg.maxFileBytes).length,
      modifiedByYear: byYear,
      walk: { ...corpus.stats, maxDepth },
      paths: { longPaths, nonAscii },
      cloudPlaceholders: { check: corpus.cloudCheck, count: cloud },
      downloadOrigin: {
        sampled: probe.length,
        withOrigin,
        withHost,
      },
    },
  };
}
