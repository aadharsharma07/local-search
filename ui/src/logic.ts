// Popup logic without DOM or Tauri: talking to lsd serve, deciding when a search counts as
// "committed" (logged), and what feedback to send. Unit-tested in test/logic.test.ts.

export interface HitFile {
  id: number;
  path: string;
  name: string;
  folder: string;
  kind: string;
  ext: string;
  mtime: number;
  size: number;
}

export interface Hit {
  paths: string[];
  files: HitFile[];
  score: number;
  snippet: string;
  page: number | null;
  trace: Record<string, unknown>;
}

export interface SearchResponse {
  q: string;
  ms: number;
  queryId: number | null;
  deep: boolean;
  hits: Hit[];
}

export interface Status {
  files: Record<string, number>;
  indexer: "idle" | "scanning" | "indexing" | "paused" | "off";
  deep: boolean;
}

export type Action = "open" | "open_folder" | "none";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Thin client for the daemon's localhost API. */
export class Api {
  constructor(
    private base: string,
    private token: string,
    private fetchFn: Fetch = (u, i) => fetch(u, i),
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    });
    if (!res.ok) throw new Error(`${path.split("?")[0]}: HTTP ${res.status}`);
    return (res.status === 204 ? null : await res.json()) as T;
  }

  search(q: string, o: { n?: number; log?: boolean; deep?: boolean; signal?: AbortSignal } = {}): Promise<SearchResponse> {
    const p = new URLSearchParams({ q, n: String(o.n ?? 12) });
    if (o.log) p.set("log", "1");
    if (o.deep) p.set("deep", "1");
    return this.call(`/search?${p}`, { signal: o.signal });
  }

  status(): Promise<Status> {
    return this.call("/status");
  }

  config(): Promise<{ roots: string[]; hotkey: string }> {
    return this.call("/config");
  }

  feedback(queryId: number, fileId: number, action: Action, rank: number | null): Promise<null> {
    return this.call("/feedback", { method: "POST", body: JSON.stringify({ queryId, fileId, action, rank }) });
  }
}

/** Wait after the last keystroke before searching. */
export const TYPE_DEBOUNCE_MS = 120;
/** Stop typing this long and the search counts as committed (logged once, for learning). */
export const COMMIT_IDLE_MS = 1500;

/**
 * One popup session: from showing the popup to hiding it. Tracks the logged query for the current
 * text so an open is attributed to it, and reports "none" when the user leaves without opening.
 */
export class Session {
  private logged: { q: string; id: number; top: HitFile | null } | null = null;
  private acted = false;

  constructor(private api: Api) {}

  /** Log the search (once per distinct text) and return its id. */
  async commit(q: string, deep = false): Promise<SearchResponse> {
    const r = await this.api.search(q, { log: true, deep });
    if (r.queryId !== null) {
      this.logged = { q: norm(q), id: r.queryId, top: r.hits[0]?.files[0] ?? null };
      this.acted = false;
    }
    return r;
  }

  isCommitted(q: string): boolean {
    return this.logged?.q === norm(q);
  }

  /** Record an action on a result; commits the search first if it wasn't yet. */
  async act(q: string, file: HitFile, rank: number, action: Exclude<Action, "none">): Promise<void> {
    if (!this.isCommitted(q)) await this.commit(q);
    if (!this.logged) return;
    this.acted = true;
    await this.api.feedback(this.logged.id, file.id, action, rank);
  }

  /** The popup is closing: a committed search with no action counts as "none" on its top hit. */
  async end(): Promise<void> {
    const l = this.logged;
    this.logged = null;
    if (l && !this.acted && l.top) await this.api.feedback(l.id, l.top.id, "none", 1);
    this.acted = false;
  }
}

const norm = (q: string) => q.toLowerCase().replace(/\s+/g, " ").trim();

/** Split text into plain and highlighted parts for the words of the query (3+ letters, prefix match). */
export function highlight(text: string, q: string): { text: string; hit: boolean }[] {
  const words = [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  if (!words.length) return text ? [{ text, hit: false }] : [];
  const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${esc.join("|")})[\\p{L}\\p{N}]*`, "giu");
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) out.push({ text: text.slice(at, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) [v, i] = [v / 1024, i + 1];
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** "today", "yesterday", "Mar 4", or "Mar 4, 2023" for other years. */
export function formatDate(ms: number, now = new Date()): string {
  const d = new Date(ms);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-US", opts);
}

/** One status line: what the indexer is doing and how many files are searchable. */
export function statusLine(s: Status): string {
  const n = (k: string) => s.files[k] ?? 0;
  const ready = n("indexed") + n("enriched");
  const queued = n("queued") + n("discovered") + n("extracting") + n("stale");
  const doing =
    s.indexer === "paused" ? "indexing paused while the GPU is busy"
    : s.indexer === "indexing" ? `indexing · ${queued} to go`
    : s.indexer === "scanning" ? "scanning folders"
    : queued ? `${queued} waiting`
    : "up to date";
  return `${ready.toLocaleString("en-US")} files · ${doing}`;
}

/** Short type label for the icon tile. */
export function typeLabel(f: HitFile): string {
  const ext = f.ext.replace(/^\./, "").toUpperCase();
  return ext.length && ext.length <= 4 ? ext : f.kind.slice(0, 3).toUpperCase();
}
