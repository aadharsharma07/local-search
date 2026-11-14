import { basename } from "node:path";
import type { FieldkitConfig } from "./config.ts";
import { INDEXED_KINDS, kindFor, type Kind } from "@local-search/daemon/shared/kinds";
import { walkAll, type WalkEntry, type WalkStats } from "@local-search/daemon/shared/walk";
import type { WorkerClient } from "@local-search/daemon/shared/worker";

export interface CorpusFile extends WalkEntry {
  kind: Kind;
  root: string;
  cloud: boolean; // cloud placeholder: never read
}

export interface Corpus {
  files: CorpusFile[];
  stats: WalkStats;
  rootsFound: string[];
  rootsMissing: string[];
  cloudCheck: "windows" | "unsupported";
}

/** One walk of the configured roots, shared by the census and the spikes. */
export async function scanCorpus(cfg: FieldkitConfig, worker?: WorkerClient): Promise<Corpus> {
  const files: CorpusFile[] = [];
  const total: WalkStats = { dirs: 0, links: 0, denied: 0, excludedDirs: 0 };
  const rootsFound: string[] = [];
  const rootsMissing: string[] = [];
  for (const root of cfg.roots) {
    const { files: fs, stats } = walkAll([root], cfg.excludeDirs);
    if (stats.dirs === 0) {
      rootsMissing.push(basename(root));
      continue;
    }
    rootsFound.push(basename(root));
    total.dirs += stats.dirs;
    total.links += stats.links;
    total.denied += stats.denied;
    total.excludedDirs += stats.excludedDirs;
    for (const f of fs) files.push({ ...f, kind: kindFor(f.ext), root: basename(root), cloud: false });
  }

  let cloudCheck: Corpus["cloudCheck"] = "unsupported";
  if (worker && process.platform === "win32") {
    for (let i = 0; i < files.length; i += 5000) {
      const batch = files.slice(i, i + 5000);
      const r = await worker.request<{ supported: boolean; placeholders: number[] }>(
        { op: "cloudattrs", paths: batch.map((f) => f.path) },
        300_000,
      );
      if (r.supported) cloudCheck = "windows";
      for (const j of r.placeholders) batch[j]!.cloud = true;
    }
  }
  return { files, stats: total, rootsFound, rootsMissing, cloudCheck };
}

/** Files the v1 indexer would actually read. */
export function indexable(c: Corpus, maxBytes: number): CorpusFile[] {
  return c.files.filter((f) => INDEXED_KINDS.has(f.kind) && !f.cloud && f.size <= maxBytes && f.size > 0);
}

/** Deterministic pseudo-random sample (same corpus, same sample). */
export function sample<T>(xs: T[], n: number, seed = 42): T[] {
  const a = [...xs];
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}
