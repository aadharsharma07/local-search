/**
 * Spike-grade chunker: ~900 tokens (3600 chars) with 15% overlap, cutting at the best nearby
 * break (heading > blank line > newline > sentence). The production chunker in Sprint 1
 * re-splits with the real tokenizer and is syntax-aware for code.
 */
export function chunkText(text: string, size = 3600, overlap = 540, window = 800): { pos: number; text: string }[] {
  const out: { pos: number; text: string }[] = [];
  const clean = text.replace(/\r\n/g, "\n");
  if (clean.trim().length === 0) return out;
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const zone = clean.slice(Math.max(start, end - window), end);
      const base = Math.max(start, end - window);
      const candidates: [RegExp, number][] = [[/\n#{1,6} /g, 100], [/\n\n/g, 20], [/\n/g, 5], [/[.!?] /g, 2]];
      let best = -1;
      let bestScore = 0;
      for (const [re, weight] of candidates) {
        for (const m of zone.matchAll(re)) {
          const at = base + m.index! + 1;
          const d = (end - at) / window;
          const score = weight * (1 - d * d * 0.7);
          if (score > bestScore) [best, bestScore] = [at, score];
        }
      }
      if (best > start) end = best;
    }
    out.push({ pos: start, text: clean.slice(start, end).trim() });
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out.filter((c) => c.text.length > 0);
}
