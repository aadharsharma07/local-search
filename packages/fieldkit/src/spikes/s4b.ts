import { detectOrigin, detectTime, detectType } from "@local-search/daemon/planner/rules";
import type { FieldkitConfig } from "../config.ts";
import { headline, loadLabeled, scoreFacets, type Prediction } from "../facets.ts";
import { cosine, EMBEDDERS, loadModel } from "../models.ts";
import { quantile, round, type SpikeResult } from "../report.ts";
import { FACET_QUESTIONS } from "./s4.ts";

const MIN_ACCURACY = 0.85;

/**
 * S4b: the cheap alternative to Laya. Time, origin and type come from rules (no model); content
 * is the nearest category description to the query vector, which search computes anyway, so the
 * extra cost is a handful of dot products. If this is close to Laya's accuracy, Laya leaves the
 * per-query path.
 *
 * Caveat: the rules were written with the fixture labels in view, so fixture accuracy flatters
 * them. Your own labeled queries are the fair measure.
 */
export async function s4b(cfg: FieldkitConfig, opts: { testsetPath?: string; embedderId?: string; now?: Date } = {}): Promise<Omit<SpikeResult, "id" | "title" | "ms">> {
  const labeled = loadLabeled(opts.testsetPath);
  const now = opts.now ?? new Date();
  const m = EMBEDDERS.find((e) => e.id === opts.embedderId) ?? EMBEDDERS[0]!;

  const model = await loadModel(m.uri, cfg.modelsDir);
  const ctx = await model.createEmbeddingContext({ contextSize: 2048 });
  const cats = Object.entries(FACET_QUESTIONS.content.criteria);
  const catVecs = [];
  for (const [label, desc] of cats) catVecs.push((await ctx.getEmbeddingFor(m.doc(label, `${label}: ${desc}`))).vector);

  const preds: Prediction[] = [];
  const extraMs: number[] = [];
  const embedMs: number[] = [];
  for (const item of labeled) {
    const e0 = performance.now();
    const qv = (await ctx.getEmbeddingFor(m.query(item.q))).vector;
    embedMs.push(performance.now() - e0);
    const t0 = performance.now();
    let best = 0;
    let bestScore = -Infinity;
    catVecs.forEach((v, i) => {
      const s = cosine(qv, v);
      if (s > bestScore) [best, bestScore] = [i, s];
    });
    preds.push({ time: detectTime(item.q, now), origin: detectOrigin(item.q), type: detectType(item.q), content: cats[best]![0] });
    extraMs.push(performance.now() - t0);
  }
  await ctx.dispose();
  await model.dispose();

  const scored = scoreFacets(labeled, preds);
  const h = headline(scored);
  const pct = (x: number) => round(x * 100);
  return {
    verdict: h.mean >= MIN_ACCURACY ? "PASS" : "FAIL",
    summary:
      `rules + ${m.id} on ${h.source} queries (${h.n}): ${pct(h.mean)}% (time ${pct(h.accuracy.time!)}, origin ${pct(h.accuracy.origin!)}, type ${pct(h.accuracy.type!)}, content ${pct(h.accuracy.content!)}; need ≥${MIN_ACCURACY * 100}); ` +
      `extra cost ${round(quantile(extraMs, 0.5), 2)} ms on top of the query embedding (${round(quantile(embedMs, 0.5))} ms)`,
    data: {
      embedder: m.id,
      accuracy: scored.bySource,
      latencyMs: { extraP50: round(quantile(extraMs, 0.5), 3), queryEmbedP50: round(quantile(embedMs, 0.5)) },
      misses: scored.misses,
      note: "Rules were written with the fixture labels visible; judge on your own labeled queries.",
    },
  };
}
