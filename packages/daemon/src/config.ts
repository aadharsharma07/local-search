import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

export function defaultPython(): string {
  return process.platform === "win32"
    ? join(REPO_ROOT, "worker", ".venv", "Scripts", "python.exe")
    : join(REPO_ROOT, "worker", ".venv", "bin", "python");
}
