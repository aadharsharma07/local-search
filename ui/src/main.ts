import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Api,
  COMMIT_IDLE_MS,
  formatDate,
  formatSize,
  highlight,
  Session,
  statusLine,
  TYPE_DEBOUNCE_MS,
  typeLabel,
  type Hit,
} from "./logic.ts";
import "./style.css";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = $<HTMLInputElement>("q");
const list = $<HTMLUListElement>("results");
const status = $<HTMLDivElement>("status");
const note = $<HTMLDivElement>("note");

let api: Api | null = null;
let session: Session | null = null;
let hits: Hit[] = [];
let selected = 0;
let shownFor = "";
let typing: number | undefined;
let idle: number | undefined;
let inflight: AbortController | null = null;
let statusTimer: number | undefined;

/** Read the port and token the daemon wrote, and let thumbnails load from the indexed folders. */
async function connect(): Promise<boolean> {
  try {
    const info = await invoke<{ port: number; token: string }>("daemon_info");
    api = new Api(`http://127.0.0.1:${info.port}`, info.token);
    const cfg = await api.config();
    await invoke("allow_roots", { roots: cfg.roots });
    await invoke("set_hotkey", { hotkey: cfg.hotkey }).catch((e) => console.warn("hotkey", e));
    session = new Session(api);
    return true;
  } catch (e) {
    api = null;
    session = null;
    setNote("The search daemon isn't running. Start it with: pnpm lsd serve", true);
    console.warn(e);
    return false;
  }
}

function setNote(text: string, error = false) {
  note.textContent = text;
  note.classList.toggle("error", error);
  note.hidden = !text;
}

async function refreshStatus() {
  if (!api) return;
  try {
    status.textContent = statusLine(await api.status());
  } catch {
    status.textContent = "daemon not reachable";
  }
}

function render(q: string) {
  list.replaceChildren(
    ...hits.map((h, i) => {
      const f = h.files[0]!;
      const li = document.createElement("li");
      li.className = i === selected ? "sel" : "";
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === selected));

      const icon = document.createElement("div");
      icon.className = "icon";
      if (f.kind === "image") {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.decoding = "async";
        img.alt = "";
        img.src = convertFileSrc(f.path);
        img.onerror = () => img.replaceWith(document.createTextNode(typeLabel(f)));
        icon.append(img);
      } else icon.textContent = typeLabel(f);

      const body = document.createElement("div");
      body.className = "body";
      const name = document.createElement("div");
      name.className = "name";
      for (const part of highlight(f.name, q)) name.append(part.hit ? mark(part.text) : part.text);
      const meta = document.createElement("div");
      meta.className = "meta";
      const dup = h.files.length > 1 ? ` · ${h.files.length} copies` : "";
      meta.textContent = `${f.folder} · ${formatDate(f.mtime)} · ${formatSize(f.size)}${h.page ? ` · p. ${h.page}` : ""}${dup}`;
      meta.title = f.path;
      body.append(name, meta);
      if (h.snippet) {
        const snip = document.createElement("div");
        snip.className = "snippet";
        for (const part of highlight(h.snippet, q)) snip.append(part.hit ? mark(part.text) : part.text);
        body.append(snip);
      }
      li.append(icon, body);
      li.onmousemove = () => select(i);
      li.onclick = (e) => void act(i, e.ctrlKey || e.metaKey ? "open_folder" : "open");
      return li;
    }),
  );
}

function mark(text: string) {
  const m = document.createElement("mark");
  m.textContent = text;
  return m;
}

function select(i: number) {
  if (i === selected || !hits.length) return;
  selected = Math.max(0, Math.min(hits.length - 1, i));
  [...list.children].forEach((el, j) => {
    el.className = j === selected ? "sel" : "";
    el.setAttribute("aria-selected", String(j === selected));
  });
  list.children[selected]?.scrollIntoView({ block: "nearest" });
}

async function runSearch(q: string, mode: "typing" | "commit" | "deep") {
  if (!api || !session) return;
  inflight?.abort();
  if (!q.trim()) {
    hits = [];
    shownFor = "";
    render(q);
    setNote("");
    return;
  }
  const ctl = (inflight = new AbortController());
  if (mode === "deep") setNote("Searching harder… (the first time loads two models)");
  try {
    const r = mode === "typing" ? await api.search(q, { signal: ctl.signal }) : await session.commit(q, mode === "deep");
    if (ctl.signal.aborted || input.value !== q) return;
    const keep = shownFor === q ? hits[selected]?.files[0]?.id : undefined;
    hits = r.hits;
    shownFor = q;
    const again = hits.findIndex((h) => h.files[0]?.id === keep);
    selected = again >= 0 ? again : 0;
    render(q);
    setNote(hits.length ? (mode === "deep" ? `Searched harder in ${r.ms} ms` : "") : "No matches.");
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    setNote(`Search failed: ${(e as Error).message}`, true);
  }
}

/** True while a result is being opened: the other app taking focus must not end the session. */
let opening = false;

async function act(i: number, action: "open" | "open_folder") {
  const h = hits[i];
  const f = h?.files[0];
  if (!h || !f || !session || opening) return;
  const q = input.value;
  opening = true;
  try {
    try {
      await invoke(action === "open" ? "open_file" : "reveal_file", { path: f.path });
    } catch (e) {
      return setNote(`Couldn't open: ${String(e)}`, true);
    }
    await session.act(q, f, i + 1, action).catch((e) => console.warn("feedback", e));
    await hide();
  } finally {
    opening = false;
  }
}

async function hide() {
  clearTimeout(typing);
  clearTimeout(idle);
  clearInterval(statusTimer);
  await session?.end().catch((e) => console.warn("feedback", e));
  await invoke("hide_popup");
}

input.addEventListener("input", () => {
  const q = input.value;
  clearTimeout(typing);
  clearTimeout(idle);
  typing = window.setTimeout(() => void runSearch(q, "typing"), TYPE_DEBOUNCE_MS);
  idle = window.setTimeout(() => {
    if (q.trim() && !session?.isCommitted(q)) void runSearch(q, "commit");
  }, COMMIT_IDLE_MS);
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    void hide();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    select(selected + 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    select(selected - 1);
  } else if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    clearTimeout(typing);
    clearTimeout(idle);
    void runSearch(input.value, "deep");
  } else if (e.key === "Enter") {
    e.preventDefault();
    void act(selected, e.ctrlKey || e.metaKey ? "open_folder" : "open");
  } else if (e.key.toLowerCase() === "c" && (e.ctrlKey || e.metaKey) && input.selectionEnd === input.selectionStart) {
    // Ctrl+C with no text selected in the box copies the selected result's path.
    const p = hits[selected]?.files[0]?.path;
    if (p) {
      e.preventDefault();
      void navigator.clipboard.writeText(p).then(() => setNote("Path copied"));
    }
  }
});

/** Each time the hotkey shows the popup: reconnect if needed, select the text, refresh status. */
async function onShown() {
  if (!api && !(await connect())) return;
  setNote("");
  input.focus();
  input.select();
  void refreshStatus();
  clearInterval(statusTimer);
  statusTimer = window.setInterval(() => void refreshStatus(), 3000);
}

void listen("popup://shown", () => void onShown());
void listen("popup://blur", () => {
  if (!opening) void hide();
});
$<HTMLButtonElement>("close").onclick = () => void hide();
// The window starts hidden; connect now so the first hotkey press is instant. In dev (tauri dev)
// the window is shown at start, so treat that as a show.
void (document.hasFocus() ? onShown() : connect());
