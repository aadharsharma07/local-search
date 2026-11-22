// Query and file-name text handling shared by search and the planner. No models: plain rules
// plus rarity weights computed from the index (see search/index.ts termWeights).

/** Safety net for very common English words. Rarity weights do most of the work. */
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it " +
    "its me my mine myself of on or our out she so some that the their them then there these they this those to " +
    "up us was we were what when where which who whom why will with would you your yours " +
    "got get made make find show give need want im ive id thing things stuff like about " +
    "probably maybe perhaps little bit around roughly approximately sometime ago"
  ).split(" "),
);

/** Light English stemmer: possessives and plurals only, so "resumes" and "resume" meet. */
export function stem(w: string): string {
  let s = w.toLowerCase().replace(/'s$/, "");
  if (s.length > 4 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 4 && /(sses|xes|ches|shes|zes)$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);
  return s;
}

const WORD = /[\p{L}\p{N}]+/gu;

/** Lower-case words, split on anything that isn't a letter or digit. Codes like "QX7P2L" stay whole. */
export function words(s: string): string[] {
  return s.toLowerCase().match(WORD) ?? [];
}

/**
 * The searchable parts of a file or folder name: whole words plus camelCase and letter/digit
 * splits, stemmed. "Jane_s_Resume___final.pdf" -> jane, s, resume, final, pdf.
 */
export function nameParts(name: string): Set<string> {
  const out = new Set<string>();
  for (const raw of name.match(WORD) ?? []) {
    out.add(stem(raw));
    const pieces = raw.split(/(?<=\p{Ll})(?=\p{Lu})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u);
    if (pieces.length > 1) for (const p of pieces) out.add(stem(p));
  }
  return out;
}

/**
 * Query terms worth matching: stemmed, de-duplicated, single letters and stopwords removed.
 * Falls back to every word when nothing is left (a query made only of common words).
 */
export function queryTerms(q: string): string[] {
  const all = [...new Set(words(q).map(stem))];
  const kept = all.filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return kept.length ? kept : all.filter((t) => t.length > 0);
}

/** Does a stemmed query term match a set of name parts? Exact, or prefix for longer terms. */
export function matchesPart(term: string, parts: Set<string>): boolean {
  if (parts.has(term)) return true;
  if (term.length < 4) return false;
  for (const p of parts) if (p.startsWith(term)) return true;
  return false;
}
