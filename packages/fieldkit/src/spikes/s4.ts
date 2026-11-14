import { detectTime } from "@local-search/daemon/planner/rules";
import { headline, loadLabeled, scoreFacets, type Prediction } from "../facets.ts";
import { quantile, round, type SpikeResult } from "../report.ts";

// Pass criteria from the blueprint.
const MIN_ACCURACY = 0.85;
const MAX_P50_MS = 250; // all four questions in one call, on the fastest provider

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

/** Execution providers to try. DirectML runs ONNX on the AMD GPU on Windows. */
function providers(): string[][] {
  return process.platform === "win32" ? [["cpu"], ["dml"]] : [["cpu"]];
}

type Answers = Record<string, { noul?: number; choice?: string; answer_confidence: number }>;

/**
 * S4: does Laya pick the right facets, fast enough? Measured on the CPU and, on Windows, on the
 * GPU through DirectML. Time is the rule detector (chrono + phrasings) OR Laya's time answer.
 * Scored on the fixture labels and on any facet labels in your test set.
 */
export async function s4(opts: { testsetPath?: string; now?: Date; limit?: number } = {}): Promise<Omit<SpikeResult, "id" | "title" | "ms">> {
  const all = loadLabeled(opts.testsetPath);
  const labeled = opts.limit ? all.slice(0, opts.limit) : all;
  const now = opts.now ?? new Date();
  const { Laya } = await import("@receptron/laya");

  const latency: Record<string, { all4P50: number; without_timeP50: number; loadMs: number } | { error: string }> = {};
  let answers: Answers[] | null = null;

  for (const ep of providers()) {
    const name = ep.join("+");
    try {
      const t0 = performance.now();
      const laya = await Laya.load({ executionProviders: ep });
      const loadMs = Math.round(performance.now() - t0);
      const all = FACET_QUESTIONS as unknown as Parameters<typeof laya.systemOne>[1];
      const { time: _time, ...rest } = FACET_QUESTIONS;
      const noTime = rest as unknown as Parameters<typeof laya.systemOne>[1];
      await laya.systemOne("Search query: warm up", all);
      const allTimes: number[] = [];
      const noTimeTimes: number[] = [];
      const got: Answers[] = [];
      for (const item of labeled) {
        const s1 = performance.now();
        const r = await laya.systemOne(`Search query: ${item.q}`, all);
        allTimes.push(performance.now() - s1);
        got.push(r.answers as unknown as Answers);
        const s2 = performance.now();
        await laya.systemOne(`Search query: ${item.q}`, noTime);
        noTimeTimes.push(performance.now() - s2);
      }
      await laya.close();
      answers ??= got; // accuracy from the first provider that runs
      latency[name] = {
        all4P50: Math.round(quantile(allTimes, 0.5)),
        without_timeP50: Math.round(quantile(noTimeTimes, 0.5)),
        loadMs,
      };
    } catch (e) {
      latency[name] = { error: (e as Error).message.slice(0, 300) };
    }
  }
  if (!answers) throw new Error(`Laya did not run: ${JSON.stringify(latency)}`);

  const preds: Prediction[] = labeled.map((item, i) => {
    const a = answers![i]!;
    return {
      time: detectTime(item.q, now) || (a.time!.noul ?? 0) >= 0.5,
      origin: (a.origin!.noul ?? 0) >= 0.5,
      type: a.type!.choice!,
      content: a.content!.choice!,
    };
  });
  const scored = scoreFacets(labeled, preds);
  const h = headline(scored);
  const best = Object.entries(latency)
    .filter((e): e is [string, { all4P50: number; without_timeP50: number; loadMs: number }] => "all4P50" in e[1])
    .sort((a, b) => a[1].all4P50 - b[1].all4P50)[0];
  const p50 = best ? best[1].all4P50 : Infinity;
  const pass = h.mean >= MIN_ACCURACY && p50 <= MAX_P50_MS;
  const pct = (x: number) => round(x * 100);

  return {
    verdict: pass ? "PASS" : "FAIL",
    summary:
      `Laya on ${h.source} queries (${h.n}): ${pct(h.mean)}% (time ${pct(h.accuracy.time!)}, origin ${pct(h.accuracy.origin!)}, type ${pct(h.accuracy.type!)}, content ${pct(h.accuracy.content!)}; need ≥${MIN_ACCURACY * 100}); ` +
      `fastest ${best?.[0] ?? "none"} p50 ${Number.isFinite(p50) ? Math.round(p50) : "n/a"} ms (need ≤${MAX_P50_MS})`,
    data: { accuracy: scored.bySource, latencyMs: latency, misses: scored.misses, criteria: { minAccuracy: MIN_ACCURACY, maxP50Ms: MAX_P50_MS } },
  };
}
