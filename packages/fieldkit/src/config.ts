import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { knownFolders } from "@local-search/daemon/shared/platform";

export interface FieldkitConfig {
  /** Folders to scan. Defaults to the usual user folders. */
  roots: string[];
  /** Folder names never entered, anywhere in the tree (case-insensitive). */
  excludeDirs: string[];
  /** Files above this size are counted but never read. */
  maxFileBytes: number;
  /** Private test set: real queries and expected files. Never leaves the PC. */
  testsetPath: string;
  /** Python interpreter that has the lsworker package installed. */
  python: string;
  /** Where downloaded models are cached. */
  modelsDir: string;
  /** Where reports are written (committed). Reports contain aggregate numbers only. */
  outDir: string;
  /** Where private, human-only review files go (never part of a report). */
  privateDir: string;
  /** Distractor files added to the expected files for S3. */
  s3Distractors: number;
  /** Per-kind sample sizes for S5. */
  s5Sample: { pdf: number; image: number; docx: number; text: number };
  /** Per-file extraction timeout. */
  extractTimeoutMs: number;
}

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

const DEFAULT_EXCLUDES = [
  "node_modules", ".git", ".svn", ".hg", "__pycache__", ".venv", "venv", ".cache", ".npm",
  ".pnpm-store", "AppData", "Application Data", "$RECYCLE.BIN", "System Volume Information",
  "Library", ".Trash", "target", "build", "dist", ".next", ".gradle", ".idea", ".vs",
  "My Games", "SteamLibrary", "steamapps", "Epic Games",
];

export function defaultConfig(): FieldkitConfig {
  const home = homedir();
  const python =
    process.platform === "win32"
      ? join(REPO_ROOT, "worker", ".venv", "Scripts", "python.exe")
      : join(REPO_ROOT, "worker", ".venv", "bin", "python");
  return {
    roots: knownFolders(["Documents", "Downloads", "Desktop", "Pictures"]),
    excludeDirs: DEFAULT_EXCLUDES,
    maxFileBytes: 10 * 1024 * 1024,
    testsetPath: join(home, ".local-search", "testset.json"),
    python,
    modelsDir: join(home, ".local-search", "models"),
    outDir: join(REPO_ROOT, "reports"),
    privateDir: join(home, ".local-search", "private"),
    s3Distractors: 1500,
    s5Sample: { pdf: 40, image: 40, docx: 20, text: 20 },
    extractTimeoutMs: 60_000,
  };
}

/** Load fieldkit.yaml (repo root or --config) over the defaults. */
export function loadConfig(path?: string): FieldkitConfig {
  const base = defaultConfig();
  const file = path ?? join(REPO_ROOT, "fieldkit.yaml");
  if (!existsSync(file)) return base;
  const user = (parse(readFileSync(file, "utf8")) ?? {}) as Partial<FieldkitConfig>;
  const home = homedir();
  const expand = (p: string) => p.replace(/^~(?=$|[\\/])/, home);
  const merged: FieldkitConfig = { ...base, ...user, s5Sample: { ...base.s5Sample, ...user.s5Sample } };
  merged.roots = merged.roots.map(expand);
  merged.testsetPath = expand(merged.testsetPath);
  merged.modelsDir = expand(merged.modelsDir);
  merged.privateDir = expand(merged.privateDir);
  if (user.excludeDirs) merged.excludeDirs = [...DEFAULT_EXCLUDES, ...user.excludeDirs];
  return merged;
}
