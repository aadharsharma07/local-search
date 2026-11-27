// Start `lsd serve` hidden at Windows logon: a small VBScript in the user's Startup folder.
// No admin rights, no Scheduled Task, and removing the file undoes it. The daemon lowers its own
// priority and logs to ~/.local-search/daemon.log.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STARTUP_FILE = "local-search-daemon.vbs";

/** The user's Startup folder (shell:startup). */
export function startupDir(env: NodeJS.ProcessEnv = process.env): string {
  if (!env.APPDATA) throw new Error("APPDATA is not set: lsd startup only works on Windows");
  return join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

/** VBScript that runs `pnpm lsd serve` in the repo with no window, appending output to a log. */
export function startupScript(repoRoot: string, logFile: string): string {
  const cmd = `cmd /c cd /d "${repoRoot}" && pnpm lsd serve >> "${logFile}" 2>&1`;
  return [
    "' Starts the local-search daemon at logon. Remove with: pnpm lsd startup remove",
    `CreateObject("WScript.Shell").Run "${cmd.replace(/"/g, '""')}", 0, False`,
    "",
  ].join("\r\n");
}

export function installStartup(repoRoot: string, dataDir: string, dir = startupDir()): string {
  const file = join(dir, STARTUP_FILE);
  writeFileSync(file, startupScript(repoRoot, join(dataDir, "daemon.log")));
  return file;
}

export function removeStartup(dir = startupDir()): boolean {
  const file = join(dir, STARTUP_FILE);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
