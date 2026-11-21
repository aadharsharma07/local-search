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
  programDirs: number; // folders skipped because they belong to a program or code project
}

export const emptyWalkStats = (): WalkStats => ({ dirs: 0, links: 0, denied: 0, excludedDirs: 0, programDirs: 0 });

/** Entries that mark a folder as a code project (file or folder names, lower-case). */
const PROJECT_MARKERS = new Set([
  ".git", "package.json", "pyproject.toml", "setup.py", "requirements.txt", "cargo.toml", "go.mod",
  "pom.xml", "build.gradle", "build.gradle.kts", "cmakelists.txt", "composer.json", "gemfile",
]);
/**
 * Extensions that mark a folder as a code project or an installed program: solution/project
 * files, DLLs, and packaged or compiled app/game files (Ren'Py, Unity, Godot, Unreal, Electron,
 * compiled Python outside __pycache__).
 */
const PROGRAM_EXTS = new Set([
  ".sln", ".csproj", ".vcxproj", ".dll",
  ".rpa", ".rpyc", ".rpyb", ".pak", ".pck", ".asar", ".unity3d", ".assets", ".pyc",
]);
/** Folder names that, next to an .exe, mark the root of an installed app or game. */
const APP_DIRS = new Set([
  "lib", "bin", "renpy", "game", "data", "resources", "locales", "plugins", "engine", "binaries",
  "content", "runtime", "jre", "mono", "monobleedingedge", "swiftshader",
]);

/**
 * True when a folder's entries show it belongs to a program or a code project rather than being
 * a folder of personal files: a project marker (package.json, .git, ...), a solution/project
 * file, a DLL or packaged game/app file, or an .exe next to typical app folders (lib, game,
 * <Name>_Data, ...). A lone installer .exe does not count.
 */
export function isProgramDir(names: string[]): boolean {
  let exe = false;
  let appDir = false;
  for (const name of names) {
    const lower = name.toLowerCase();
    const ext = extname(lower);
    if (PROJECT_MARKERS.has(lower) || PROGRAM_EXTS.has(ext)) return true;
    if (ext === ".exe") exe = true;
    if (APP_DIRS.has(lower) || lower.endsWith("_data")) appDir = true;
  }
  return exe && appDir;
}

/**
 * Walk a folder tree without following symlinks or junctions (on Windows, lstat reports
 * junctions as symbolic links). Never reads file contents. Errors are counted, not thrown.
 * Program and code-project folders (see isProgramDir) are skipped with everything under them;
 * the root itself is always walked.
 */
export function* walk(
  root: string,
  excludeDirs: string[],
  stats: WalkStats = emptyWalkStats(),
): Generator<WalkEntry, WalkStats> {
  const exclude = new Set(excludeDirs.map((d) => d.toLowerCase()));
  const stack: [string, number][] = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      stats.denied++;
      continue;
    }
    if (depth > 0 && isProgramDir(names)) {
      stats.programDirs++;
      continue;
    }
    stats.dirs++;
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
  const stats = emptyWalkStats();
  const files: WalkEntry[] = [];
  for (const root of roots) for (const f of walk(root, excludeDirs, stats)) files.push(f);
  return { files, stats };
}
