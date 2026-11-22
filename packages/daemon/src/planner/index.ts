import * as chrono from "chrono-node";
import { queryTerms } from "../shared/text.ts";
import { detectOrigin, detectType } from "./rules.ts";

/**
 * What a query asks for, beyond its words. Built from model-free rules (Visit 1: rules plus the
 * query vector beat Laya); the content facet is left to the vector retriever itself.
 */
export interface QueryPlan {
  /** Words to match (stemmed, filler removed); recency phrases are taken out. */
  terms: string[];
  /** A time the query mentions, as a window. Used as a ranking boost, never a filter. */
  time?: { from: number; to: number; text: string; lean?: "before" | "after" };
  /** "my latest ..." / "the original ...", when no explicit time is given. */
  recency?: "newest" | "oldest";
  /** File type asked for. Code is not indexed in v1, so it counts as unspecified. */
  type: "document" | "image" | "text" | "unspecified";
  /** Asks for a screenshot specifically. */
  screenshot: boolean;
  /** Says the file came from somewhere (downloaded, emailed, sent). */
  origin: boolean;
}

const NEWEST = /\b(latest|newest|most recent|recent|most up[- ]?to[- ]?date|up[- ]?to[- ]?date|uptodate|current|final|last version|updated)\b/i;
const OLDEST = /\b(oldest|original|first version|older|old|previous|earlier version|outdated)\b/i;
const SCREENSHOT = /\b(screen ?shots?|screen ?grabs?|screen ?caps?)\b/i;
const DAY = 86_400_000;

const SEASONS: Record<string, [number, number]> = {
  spring: [2, 4],
  summer: [5, 7],
  fall: [8, 10],
  autumn: [8, 10],
  winter: [11, 13], // Dec to Feb, spills into next year
};

/** A time window for the first date phrase chrono or the season rule finds. */
export function timeWindow(q: string, now: Date): QueryPlan["time"] {
  const lean = /\b(or )?(a little |slightly |bit )?(earlier|before)\b/i.test(q)
    ? "before"
    : /\b(or )?(a little |slightly |bit )?(later|after)\b/i.test(q)
      ? "after"
      : undefined;
  const r = chrono.parse(q, now, { forwardDate: false })[0];
  if (r) {
    const s = r.start;
    const d = s.date();
    let from: Date;
    let to: Date;
    if (r.end) {
      from = d;
      to = r.end.date();
    } else if (s.isCertain("day")) {
      from = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      to = new Date(from.getTime() + DAY);
    } else if (s.isCertain("month")) {
      from = new Date(d.getFullYear(), d.getMonth(), 1);
      to = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    } else if (s.isCertain("year")) {
      from = new Date(d.getFullYear(), 0, 1);
      to = new Date(d.getFullYear() + 1, 0, 1);
    } else {
      // Relative phrases like "three years ago": about a month either side.
      from = new Date(d.getTime() - 30 * DAY);
      to = new Date(d.getTime() + 30 * DAY);
    }
    return { from: from.getTime(), to: to.getTime(), text: r.text, ...(lean ? { lean } : {}) };
  }
  const m = /\b(last|this|past)?\s*(spring|summer|fall|autumn|winter)(?:\s+(?:of\s+)?((?:19|20)\d{2}))?\b/i.exec(q);
  if (m) {
    const [startMonth, endMonth] = SEASONS[m[2]!.toLowerCase()]!;
    // Explicit year wins; "this summer" is this year; otherwise the most recent one that has
    // started ("last summer" in November is this year's; in March it is last year's).
    const prefix = m[1]?.toLowerCase();
    const started = now.getMonth() >= startMonth;
    const year = m[3] ? Number(m[3]) : prefix === "this" || started ? now.getFullYear() : now.getFullYear() - 1;
    return {
      from: new Date(year, startMonth, 1).getTime(),
      to: new Date(year, endMonth + 1, 1).getTime(),
      text: m[0].trim(),
      ...(lean ? { lean } : {}),
    };
  }
  // A bare year ("taxes 2023"), which chrono leaves alone.
  const y = /\b((?:19|20)\d{2})\b/.exec(q);
  if (y) {
    const year = Number(y[1]);
    return { from: new Date(year, 0, 1).getTime(), to: new Date(year + 1, 0, 1).getTime(), text: y[0], ...(lean ? { lean } : {}) };
  }
  return undefined;
}

const LEAN = /\b(or )?(a little |slightly |bit )?(earlier|before|later|after)\b/gi;

export function plan(q: string, now = new Date()): QueryPlan {
  const time = timeWindow(q, now);
  const recency = time ? undefined : NEWEST.test(q) ? "newest" : OLDEST.test(q) ? "oldest" : undefined;
  // Words to match: the date phrase, its lean and any recency phrase are handled by the plan,
  // so they leave the terms (they would otherwise dilute name matching).
  let words = q.replace(NEWEST, " ").replace(OLDEST, " ");
  if (time) words = words.replace(time.text, " ").replace(LEAN, " ");
  const t = detectType(q);
  return {
    terms: queryTerms(words),
    ...(time ? { time } : {}),
    ...(recency ? { recency } : {}),
    type: t === "code" ? "unspecified" : (t as QueryPlan["type"]),
    screenshot: SCREENSHOT.test(q),
    origin: detectOrigin(q.replace(SCREENSHOT, " ")),
  };
}

/**
 * How well a file date fits a time window: 1 inside, decaying with distance outside (scale =
 * window length). "or a little earlier" makes dates after the window fall off faster, and the
 * reverse for "later".
 */
export function timeFit(date: number, w: NonNullable<QueryPlan["time"]>): number {
  if (date >= w.from && date < w.to) return 1;
  const len = Math.max(w.to - w.from, DAY);
  const before = date < w.from;
  const dist = before ? w.from - date : date - w.to;
  const scale = w.lean === "before" ? (before ? len : len / 4) : w.lean === "after" ? (before ? len / 4 : len) : len / 2;
  return Math.exp(-dist / scale);
}
