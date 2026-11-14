import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as chrono from "chrono-node";
import { REPO_ROOT } from "../config.ts";
import { quantile, round, type SpikeResult } from "../report.ts";

// Pass criteria from the blueprint.
const MIN_ACCURACY = 0.85;
const MAX_P50_MS = 200;

interface Labeled {
  q: string;
  time: boolean;
  origin: boolean;
  type: string;
  content: string;
}

/** The facet questions Laya answers for every query. These become the production planner. */
export const FACET_QUESTIONS = {
  time: {
    type: "noul",
    instructions:
      "Does this file search mention a specific date, year, month or time period, such as 'last summer', '2023' or 'three years ago'?",
  },
  origin: {
    type: "noul",
    instructions:
      "Does this file search say where the file came from, such as a website, a download, an email, a chat app or a screenshot?",
  },
  type: {
    type: "choice",
    instructions: "What kind of file is the person looking for?",
    criteria: {
      document: "a PDF, Word document, form, receipt, bill, statement, contract or letter",
      image: "a photo, picture, screenshot, scan saved as an image, or drawing",
      code: "source code, a script or a configuration file",
      text: "plain-text notes, markdown notes or a journal",
      unspecified: "the search does not say what kind of file it is",
    },
  },
  content: {
    type: "choice",
    instructions: "Which area of the person's life is this file about?",
    criteria: {
      finance: "purchases, receipts, bills, bank statements, warranties, subscriptions, budgets",
      taxes: "tax returns, tax forms, tax slips, tuition and other tax receipts",
      housing: "leases, rent, apartments, moving, landlords",
      work: "jobs, clients, invoices sent, contracts, resumes, meetings",
      school: "courses, lectures, assignments, exams, group projects",
      travel: "flights, hotels, trips, passports, bookings",
      code: "software, programming, scripts, servers, error messages",
      art: "drawings, sketches, designs, wallpapers, creative work",
      recipes: "cooking and baking recipes",
      health: "doctors, prescriptions, lab results, vaccinations",
      personal: "personal notes, journals, ideas, lists",
    },
  },
} as const;

/** S4: does Laya pick the right facets for real queries, fast enough on this CPU? */
export async function s4(opts: { file?: string; now?: Date } = {}): Promise<Omit<SpikeResult, "id" | "title" | "ms">> {
  const file = opts.file ?? join(REPO_ROOT, "fixtures", "laya-facets.json");
  const labeled = (JSON.parse(readFileSync(file, "utf8")) as { queries: Labeled[] }).queries;
  const { Laya } = await import("@receptron/laya");

  const t0 = performance.now();
  const laya = await Laya.load();
  const loadMs = performance.now() - t0;
  // Questions are passed as-is; the object shape matches Laya's question types.
  const questions = FACET_QUESTIONS as unknown as Parameters<typeof laya.systemOne>[1];
  await laya.systemOne("Search query: warm up", questions);

  const correct = { time: 0, origin: 0, type: 0, content: 0 };
  const latencies: number[] = [];
  const confidences: number[] = [];
  const misses: { q: string; facet: string; want: string; got: string; p: number }[] = [];
  for (const item of labeled) {
    const s = performance.now();
    const r = await laya.systemOne(`Search query: ${item.q}`, questions);
    latencies.push(performance.now() - s);
    const a = r.answers as Record<string, { noul?: number; choice?: string; answer_confidence: number }>;
    const got = {
      time: (a.time!.noul ?? 0) >= 0.5,
      origin: (a.origin!.noul ?? 0) >= 0.5,
      type: a.type!.choice!,
      content: a.content!.choice!,
    };
    for (const k of ["time", "origin", "type", "content"] as const) {
      confidences.push(a[k]!.answer_confidence);
      if (got[k] === item[k]) correct[k]++;
      else misses.push({ q: item.q, facet: k, want: String(item[k]), got: String(got[k]), p: round(a[k]!.answer_confidence, 2) });
    }
  }
  await laya.close();

  // Date parsing is done by chrono, not Laya: how many time-labeled queries does it resolve?
  const now = opts.now ?? new Date();
  const timeQs = labeled.filter((l) => l.time);
  const parsed = timeQs.filter((l) => chrono.parse(l.q, now).length > 0);

  const n = labeled.length;
  const acc = Object.fromEntries(Object.entries(correct).map(([k, v]) => [k, round(v / n, 3)])) as Record<string, number>;
  const mean = (acc.time! + acc.origin! + acc.type! + acc.content!) / 4;
  const p50 = quantile(latencies, 0.5);
  const pass = mean >= MIN_ACCURACY && p50 <= MAX_P50_MS;

  return {
    verdict: pass ? "PASS" : "FAIL",
    summary: `facet accuracy ${round(mean * 100)}% (time ${round(acc.time! * 100)}, origin ${round(acc.origin! * 100)}, type ${round(acc.type! * 100)}, content ${round(acc.content! * 100)}; need ≥${MIN_ACCURACY * 100}), p50 ${Math.round(p50)} ms (need ≤${MAX_P50_MS}); chrono parsed ${parsed.length}/${timeQs.length} dates`,
    data: {
      queries: n,
      accuracy: acc,
      meanAccuracy: round(mean, 3),
      latencyMs: { p50: Math.round(p50), p95: Math.round(quantile(latencies, 0.95)), load: Math.round(loadMs) },
      meanConfidence: round(confidences.reduce((a, b) => a + b, 0) / confidences.length, 3),
      chrono: { timeQueries: timeQs.length, parsed: parsed.length },
      // Fixture queries are synthetic, so listing misses is safe and useful.
      misses,
      criteria: { minAccuracy: MIN_ACCURACY, maxP50Ms: MAX_P50_MS },
    },
  };
}
