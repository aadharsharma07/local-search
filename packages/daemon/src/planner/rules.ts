import * as chrono from "chrono-node";

// Model-free facet rules. Spike S4b measures these (plus embedding similarity for the content
// facet) against Laya. They are deliberately small and generic; Visit 1 decides what survives.

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
const TIME_RE = new RegExp(
  [
    String.raw`\b(19|20)\d{2}\b`,
    String.raw`\b(yesterday|today|tonight|recently|lately)\b`,
    String.raw`\b\w+ (days?|weeks?|months?|years?) ago\b`,
    String.raw`\b(last|this|next|past) (week|month|year|summer|winter|spring|fall|autumn|semester|term|weekend|night)\b`,
    String.raw`\b(spring|summer|fall|autumn|winter)( of)? (19|20)\d{2}\b`,
    String.raw`\b(${MONTHS})\b`,
  ].join("|"),
  "i",
);

/** Does the query constrain time? chrono first, then common phrasings chrono misses. */
export function detectTime(q: string, now = new Date()): boolean {
  if (chrono.parse(q, now).length > 0) return true;
  // "may" is also a verb; require it next to a date-ish word.
  const m = TIME_RE.exec(q);
  if (!m) return false;
  return !/^may$/i.test(m[0]) || /\bmay (\d|of|20)/i.test(q);
}

const ORIGIN_RE =
  /\b(download(ed)?|e-?mail(ed)?|sent (me|to me)|attachment|screenshot|screen ?shot|screen grab|off (reddit|the internet|the web|twitter|x)|from (the )?(website|site|internet|web|reddit|discord|slack|whatsapp|messenger|teams|drive|dropbox|store|shop))\b/i;

/** Does the query say where the file came from? */
export function detectOrigin(q: string): boolean {
  return ORIGIN_RE.test(q);
}

const TYPE_RULES: [string, RegExp][] = [
  ["image", /\b(photos?|pictures?|pics?|images?|screenshots?|screen ?shots?|drawings?|sketch(es)?|wallpapers?|selfies?|memes?|jpe?g|png|scan of (my|the) (passport|id|license))\b|\bpassport scan\b/i],
  ["code", /\b(code|scripts?|functions?|config(uration)? files?|repo|class|module|python|rust|typescript|javascript|bash|powershell|sql|\.py|\.ts|\.rs)\b/i],
  ["document", /\b(pdf|docx?|word doc(ument)?|receipts?|bills?|statements?|contracts?|leases?|forms?|invoices?|letters?|resumes?|cv|tax returns?|w-?2|t4|slips?|warrant(y|ies)|records?|certificates?|lab results|prescriptions?)\b/i],
  ["text", /\b(notes?|journal( entry)?|diary|checklists?|lists?|ideas|todo|to-do|markdown|txt)\b/i],
];

/** What kind of file is asked for, or "unspecified". First matching rule wins. */
export function detectType(q: string): string {
  for (const [type, re] of TYPE_RULES) if (re.test(q)) return type;
  return "unspecified";
}
