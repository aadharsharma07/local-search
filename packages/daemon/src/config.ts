import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { parse } from "yaml";
import { knownFolders } from "./shared/platform.ts";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
export const DATA_DIR = join(homedir(), ".local-search");

export const DEFAULT_EXCLUDES = [
  "node_modules", ".git", ".svn", ".hg", "__pycache__", ".venv", "venv", ".cache", ".npm",
  ".pnpm-store", "AppData", "Application Data", "$RECYCLE.BIN", "System Volume Information",
  "Library", ".Trash", "target", "build", "dist", ".next", ".gradle", ".idea", ".vs",
  "My Games", "SteamLibrary", "steamapps", "Epic Games",
];

/** The usual user folders, following Windows/OneDrive redirection. */
export function defaultRoots(): string[] {
  return knownFolders(["Documents", "Downloads", "Desktop", "Pictures"]);
}

/** Settings read from ~/.local-search/config.yaml. Every key is optional. */
export interface DaemonConfig {
  /** Folders to index. Default: Documents, Downloads, Desktop, Pictures (wherever Windows put them). */
  roots: string[];
  /** Folder names skipped anywhere: the built-in list plus any listed in the file. */
  excludeDirs: string[];
  /** Rerank the top results with a cross-encoder (off by default; see docs/DECISIONS.md). */
  rerank: boolean;
  /** Rewrite weak queries with a small LLM and search again (off by default). */
  expand: boolean;
  /** Port for `lsd serve` on 127.0.0.1. */
  port: number;
  /** "Search harder" (Shift+Enter in the popup): rerank + expansion for one search, models loaded on demand. */
  deepSearch: boolean;
  /** Global shortcut that opens the popup (Tauri accelerator syntax). */
  hotkey: string;
}

export const CONFIG_PATH = join(DATA_DIR, "config.yaml");

/** Load the daemon config over the defaults. A missing file means defaults. */
export function loadDaemonConfig(path = CONFIG_PATH): DaemonConfig {
  const base: DaemonConfig = {
    roots: defaultRoots(),
    excludeDirs: DEFAULT_EXCLUDES,
    rerank: false,
    expand: false,
    port: 7337,
    deepSearch: true,
    hotkey: "Alt+Space",
  };
  if (!existsSync(path)) return base;
  const user = (parse(readFileSync(path, "utf8")) ?? {}) as Partial<DaemonConfig>;
  const expand = (p: string) => normalize(p.replace(/^~(?=$|[\\/])/, homedir()));
  return {
    roots: user.roots?.length ? user.roots.map(expand) : base.roots,
    excludeDirs: [...DEFAULT_EXCLUDES, ...(user.excludeDirs ?? [])],
    rerank: user.rerank ?? base.rerank,
    expand: user.expand ?? base.expand,
    port: user.port ?? base.port,
    deepSearch: user.deepSearch ?? base.deepSearch,
    hotkey: user.hotkey ?? base.hotkey,
  };
}

export function defaultPython(): string {
  return process.platform === "win32"
    ? join(REPO_ROOT, "worker", ".venv", "Scripts", "python.exe")
    : join(REPO_ROOT, "worker", ".venv", "bin", "python");
}
