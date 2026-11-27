import { describe, expect, it } from "vitest";
import { Api, formatDate, formatSize, highlight, Session, statusLine, typeLabel, type Fetch, type HitFile } from "../src/logic.ts";

const file = (id: number, name = `f${id}.pdf`): HitFile => ({
  id, path: `C:\\Users\\me\\Documents\\${name}`, name, folder: "C:\\Users\\me\\Documents", kind: "document", ext: ".pdf", mtime: 0, size: 10,
});

/** A fake daemon: records calls, answers searches with two hits. */
function fakeDaemon() {
  const calls: { url: string; body?: unknown; auth?: string }[] = [];
  let nextId = 1;
  const fetchFn: Fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({
      url: u.pathname + u.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init?.headers as Record<string, string>)?.authorization,
    });
    if (u.pathname === "/feedback") return new Response(null, { status: 204 });
    const log = u.searchParams.get("log") === "1";
    const body = { q: u.searchParams.get("q"), ms: 3, deep: u.searchParams.get("deep") === "1", queryId: log ? nextId++ : null,
      hits: [file(10), file(20)].map((f) => ({ paths: [f.path], files: [f], score: 1, snippet: "", page: null, trace: {} })) };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { calls, api: new Api("http://127.0.0.1:7337", "tok", fetchFn) };
}

describe("Api", () => {
  it("sends the token and the search options", async () => {
    const { calls, api } = fakeDaemon();
    await api.search("tax 2023", { log: true, deep: true, n: 5 });
    expect(calls[0]).toMatchObject({ url: "/search?q=tax+2023&n=5&log=1&deep=1", auth: "Bearer tok" });
  });

  it("raises on HTTP errors", async () => {
    const api = new Api("http://x", "t", async () => new Response("{}", { status: 401 }));
    await expect(api.status()).rejects.toThrow("/status: HTTP 401");
  });
});

describe("Session feedback", () => {
  it("commits before the first action and reports what was opened", async () => {
    const { calls, api } = fakeDaemon();
    const s = new Session(api);
    await s.act("lease", file(20), 2, "open");
    expect(calls.map((c) => c.url)).toEqual(["/search?q=lease&n=12&log=1", "/feedback"]);
    expect(calls[1]!.body).toEqual({ queryId: 1, fileId: 20, action: "open", rank: 2 });
    await s.end();
    expect(calls).toHaveLength(2); // acted: no "none"
  });

  it("reuses the committed search for the same words", async () => {
    const { calls, api } = fakeDaemon();
    const s = new Session(api);
    await s.commit("my  Lease");
    expect(s.isCommitted("my lease")).toBe(true);
    await s.act("my lease", file(10), 1, "open_folder");
    expect(calls.filter((c) => c.url.startsWith("/search"))).toHaveLength(1);
  });

  it("records 'none' on the top hit when the popup closes without an open", async () => {
    const { calls, api } = fakeDaemon();
    const s = new Session(api);
    await s.commit("receipts");
    await s.end();
    expect(calls.at(-1)!.body).toEqual({ queryId: 1, fileId: 10, action: "none", rank: 1 });
    await s.end();
    expect(calls.filter((c) => c.url === "/feedback")).toHaveLength(1); // only once
  });

  it("sends nothing for searches that were never committed", async () => {
    const { calls, api } = fakeDaemon();
    const s = new Session(api);
    await api.search("typ");
    await s.end();
    expect(calls.filter((c) => c.url === "/feedback")).toHaveLength(0);
  });
});

describe("display helpers", () => {
  it("highlights query words by prefix, case-insensitively", () => {
    expect(highlight("Rent receipts for 2023", "receipt rent")).toEqual([
      { text: "Rent", hit: true },
      { text: " ", hit: false },
      { text: "receipts", hit: true },
      { text: " for 2023", hit: false },
    ]);
    expect(highlight("abc", "a.*")).toEqual([{ text: "abc", hit: false }]);
  });

  it("formats sizes and dates", () => {
    expect(formatSize(900)).toBe("900 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(5 * 1024 ** 3)).toBe("5.0 GB");
    const now = new Date(2026, 10, 26, 15);
    expect(formatDate(new Date(2026, 10, 26, 1).getTime(), now)).toBe("today");
    expect(formatDate(new Date(2026, 10, 25, 23).getTime(), now)).toBe("yesterday");
    expect(formatDate(new Date(2026, 2, 4).getTime(), now)).toBe("Mar 4");
    expect(formatDate(new Date(2023, 2, 4).getTime(), now)).toBe("Mar 4, 2023");
  });

  it("summarizes indexer status", () => {
    expect(statusLine({ files: { indexed: 1002, queued: 40 }, indexer: "indexing", deep: true })).toBe("1,002 files · indexing · 40 to go");
    expect(statusLine({ files: { indexed: 5 }, indexer: "paused", deep: true })).toBe("5 files · indexing paused while the GPU is busy");
    expect(statusLine({ files: { indexed: 5 }, indexer: "idle", deep: false })).toBe("5 files · up to date");
  });

  it("labels file types", () => {
    expect(typeLabel(file(1))).toBe("PDF");
    expect(typeLabel({ ...file(1), ext: "", kind: "image" })).toBe("IMA");
  });
});
