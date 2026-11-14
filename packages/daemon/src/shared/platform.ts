import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
