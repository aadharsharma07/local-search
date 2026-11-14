import { lstatSync, readdirSync, type Stats } from "node:fs";
import { extname, join } from "node:path";

export interface WalkEntry {
  path: string;
  ext: string; // lower-case, with dot, "" when none
  size: number;
  mtimeMs: number;
  depth: number;
}

export interface WalkStats {
  dirs: number;
  links: number; // symlinks and junctions, never followed
  denied: number; // folders or files we could not read
  excludedDirs: number;
}

/**
 * Walk a folder tree without following symlinks or junctions (on Windows, lstat reports
 * junctions as symbolic links). Never reads file contents. Errors are counted, not thrown.
 */
export function* walk(
  root: string,
  excludeDirs: string[],
  stats: WalkStats = { dirs: 0, links: 0, denied: 0, excludedDirs: 0 },
): Generator<WalkEntry, WalkStats> {
  const exclude = new Set(excludeDirs.map((d) => d.toLowerCase()));
  const stack: [string, number][] = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
      stats.dirs++;
    } catch {
      stats.denied++;
      continue;
    }
    for (const name of names) {
      const full = join(dir, name);
      let st: Stats;
      try {
        st = lstatSync(full);
      } catch {
        stats.denied++;
        continue;
      }
      if (st.isSymbolicLink()) {
        stats.links++;
        continue;
      }
      if (st.isDirectory()) {
        if (exclude.has(name.toLowerCase()) || name.startsWith("~$")) stats.excludedDirs++;
        else stack.push([full, depth + 1]);
        continue;
      }
      if (!st.isFile() || name.startsWith("~$") || name.toLowerCase() === "desktop.ini") continue;
      yield {
        path: full,
        ext: extname(name).toLowerCase(),
        size: st.size,
        mtimeMs: st.mtimeMs,
        depth: depth + 1,
      };
    }
  }
  return stats;
}

/** Collect a walk into an array plus its stats. */
export function walkAll(roots: string[], excludeDirs: string[]) {
  const stats: WalkStats = { dirs: 0, links: 0, denied: 0, excludedDirs: 0 };
  const files: WalkEntry[] = [];
  for (const root of roots) for (const f of walk(root, excludeDirs, stats)) files.push(f);
  return { files, stats };
}
