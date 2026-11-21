import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type KnownFolder = "Documents" | "Downloads" | "Desktop" | "Pictures";

/** Registry value names under Explorer\User Shell Folders. */
const SHELL_FOLDER_VALUES: Record<KnownFolder, string> = {
  Documents: "Personal",
  Downloads: "{374DE290-123F-4565-9164-39C4925E467B}",
  Desktop: "Desktop",
  Pictures: "My Pictures",
};

/**
 * Real locations of the user folders. On Windows these can be redirected (OneDrive folder
 * backup moves Desktop, Documents and Pictures to ~/OneDrive/...), so ~/Desktop may not exist.
 * Falls back to ~/<name> when a folder is not redirected or the registry can't be read.
 */
export function knownFolders(names: KnownFolder[]): string[] {
  const home = homedir();
  let redirected: Partial<Record<KnownFolder, string>> = {};
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "reg",
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
      redirected = parseShellFolders(out, process.env);
    } catch {
      // keep defaults
    }
  }
  return names.map((n) => redirected[n] ?? join(home, n));
}

/** Parse `reg query` output for the user shell folders, expanding %VARS%. */
export function parseShellFolders(
  regOutput: string,
  env: Record<string, string | undefined>,
): Partial<Record<KnownFolder, string>> {
  const values = new Map<string, string>();
  for (const line of regOutput.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (m) values.set(m[1]!.toLowerCase(), m[2]!);
  }
  const lowerEnv = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  const expand = (s: string) => s.replace(/%([^%]+)%/g, (all, k: string) => lowerEnv.get(k.toLowerCase()) ?? all);
  const result: Partial<Record<KnownFolder, string>> = {};
  for (const [folder, value] of Object.entries(SHELL_FOLDER_VALUES) as [KnownFolder, string][]) {
    const raw = values.get(value.toLowerCase());
    if (!raw) continue;
    const path = expand(raw);
    if (!path.includes("%")) result[folder] = path;
  }
  return result;
}

export interface Origin {
  hostUrl?: string;
  referrerUrl?: string;
  zoneId?: number;
}

/**
 * Where a downloaded file came from.
 * - Windows: the Zone.Identifier alternate data stream browsers write on download.
 * - macOS: the kMDItemWhereFroms metadata attribute (development stand-in).
 * Returns null when the file carries no origin.
 */
export function readOrigin(path: string): Origin | null {
  if (process.platform === "win32") {
    let raw: string;
    try {
      raw = readFileSync(`${path}:Zone.Identifier`, "utf8");
    } catch {
      return null;
    }
    return parseZoneIdentifier(raw);
  }
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("mdls", ["-raw", "-name", "kMDItemWhereFroms", path], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const urls = [...out.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
      return urls.length ? { hostUrl: urls[0], referrerUrl: urls[1] } : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function parseZoneIdentifier(raw: string): Origin {
  const origin: Origin = {};
  for (const line of raw.replace(/^﻿/, "").split(/\r?\n/)) {
    const [k, ...rest] = line.split("=");
    const v = rest.join("=").trim();
    if (k === "HostUrl" && v) origin.hostUrl = v;
    else if (k === "ReferrerUrl" && v) origin.referrerUrl = v;
    else if (k === "ZoneId" && v) origin.zoneId = Number(v);
  }
  return origin;
}

/** Host part of a URL, or null. Only hosts go into reports, never full URLs. */
export function hostOf(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
