import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultPython, loadDaemonConfig } from "../src/config.ts";
import { embeddingFingerprint, openDb } from "../src/db/index.ts";
import { IdleLoader, parseVariants } from "../src/embed/extras.ts";
import { HashEmbedder } from "../src/embed/index.ts";
import { openedFor, recordFeedback } from "../src/search/feedback.ts";
import { search, searchWithMeta } from "../src/search/index.ts";
import { Indexer, parseGpuCounters, startServer } from "../src/serve.ts";
import { WorkerClient } from "../src/shared/worker.ts";

const HEAVY = !!(process.env.CI || process.env.LS_HEAVY_TESTS);

function seeded() {
  const db = openDb(":memory:");
  const add = (path: string, text: string) => {
    db.prepare("INSERT INTO contents(hash, text, extractor, extracted_at) VALUES (?, ?, 't', 0)").run(path, text);
    db.prepare("INSERT INTO chunks(content_hash, seq, pos, text) VALUES (?, 0, 0, ?)").run(path, text);
    db.prepare(
      "INSERT INTO files(path, content_hash, size, mtime, ext, kind, state, first_seen) VALUES (?, ?, 1, 0, '.txt', 'text', 'indexed', 0)",
    ).run(path, path);
  };
  add("/n/banana bread.txt", "Banana bread: three ripe bananas, flour, sugar.");
  add("/n/lease.txt", "Lease agreement. Rent is due on the first. Pets allowed with deposit.");
  add("/n/notes.txt", "Meeting notes about the quarterly plan.");
  return db;
}

describe("GPU counters", () => {
  it("sums 3D-engine use of other processes only", () => {
    const out = [
      "pid_100_luid_0x0_0x1_phys_0_eng_0_engtype_3d\t40.5",
      "pid_200_luid_0x0_0x1_phys_0_eng_0_engtype_3d\t10",
      "pid_200_luid_0x0_0x1_phys_0_eng_1_engtype_3d\t0",
      "garbage line",
    ].join("\r\n");
    expect(parseGpuCounters(out, 100)).toBe(10);
    expect(parseGpuCounters(out, 999)).toBe(50.5);
  });
});

describe("idle loader", () => {
  it("loads once on first use and unloads after the idle time", async () => {
    let opens = 0;
    let disposed = 0;
    const l = new IdleLoader(async () => (opens++, { value: "model", dispose: async () => void disposed++ }), 30);
    expect(l.loaded).toBe(false);
    expect(await Promise.all([l.get(), l.get()])).toEqual(["model", "model"]);
    expect(opens).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(disposed).toBe(1);
    expect(l.loaded).toBe(false);
    await l.get();
    expect(opens).toBe(2);
    await l.close();
  });

  it("retries after a failed load", async () => {
    let n = 0;
    const l = new IdleLoader(async () => {
      if (++n === 1) throw new Error("no GPU memory");
      return { value: n, dispose: async () => {} };
    });
    await expect(l.get()).rejects.toThrow("no GPU memory");
    expect(await l.get()).toBe(2);
    await l.close();
  });
});

describe("expansion output", () => {
  it("keeps up to three new, clean phrasings", () => {
    const out = "1. rental agreement\n- lease contract\nmy lease\nlease contract\napartment lease terms\nextra";
    expect(parseVariants(out, "my lease")).toEqual(["rental agreement", "lease contract", "apartment lease terms"]);
  });
});

describe("optional rerank and expansion", () => {
  it("expands only weak queries and fuses the variants", async () => {
    const db = seeded();
    let calls = 0;
    const expand = async () => {
      calls++;
      return ["banana bread"];
    };
    const weak = await search(db, null, "zzz loaf", { expand });
    expect(calls).toBe(1);
    expect(weak[0]!.paths[0]).toBe("/n/banana bread.txt");
    expect(weak[0]!.trace.expanded).toBe(true);
    await search(db, null, "banana bread", { expand });
    expect(calls).toBe(1); // a strong first result never expands
  });

  it("lets the reranker reorder the top results", async () => {
    const db = seeded();
    const rerank = async (_q: string, docs: string[]) => docs.map((d) => (d.includes("Lease") ? 1 : 0));
    const hits = await search(db, null, "notes lease bread", { rerank });
    expect(hits[0]!.paths[0]).toBe("/n/lease.txt");
    expect(hits[0]!.trace.rerank).toBe(1);
  });
});

describe("localhost API", () => {
  it("requires the token, then searches and reports status", async () => {
    const { server, port } = await startServer({ db: seeded(), embedder: new HashEmbedder(), token: "t0k", port: 0 });
    try {
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/status`)).status).toBe(401);
      const auth = { headers: { authorization: "Bearer t0k" } };
      const r = (await (await fetch(`${base}/search?q=banana%20bread&n=2`, auth)).json()) as { hits: { paths: string[] }[] };
      expect(r.hits[0]!.paths[0]).toBe("/n/banana bread.txt");
      const st = (await (await fetch(`${base}/status`, auth)).json()) as { files: Record<string, number>; indexer: string };
      expect(st.files.indexed).toBe(3);
      expect(st.indexer).toBe("off");
      expect((await fetch(`${base}/search`, auth)).status).toBe(400);
    } finally {
      server.close();
    }
  });

  it("logs only committed searches and records feedback", async () => {
    const db = seeded();
    const { server, port } = await startServer({ db, embedder: new HashEmbedder(), token: "t0k", port: 0 });
    try {
      const base = `http://127.0.0.1:${port}`;
      const auth = { authorization: "Bearer t0k" };
      type Res = { queryId: number | null; hits: { files: { id: number; name: string; kind: string }[] }[] };
      const typing = (await (await fetch(`${base}/search?q=lea`, { headers: auth })).json()) as Res;
      expect(typing.queryId).toBeNull();
      const committed = (await (await fetch(`${base}/search?q=lease&log=1`, { headers: auth })).json()) as Res;
      expect(committed.queryId).toBeGreaterThan(0);
      const file = committed.hits[0]!.files[0]!;
      expect(file).toMatchObject({ name: "lease.txt", kind: "text" });
      expect((db.prepare("SELECT count(*) AS n FROM queries").get() as { n: number }).n).toBe(1);

      const post = (body: unknown) =>
        fetch(`${base}/feedback`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
      expect((await post({ queryId: committed.queryId, fileId: file.id, action: "open", rank: 1 })).status).toBe(204);
      expect((await post({ queryId: committed.queryId, fileId: file.id, action: "delete" })).status).toBe(400);
      expect((await post({ queryId: 999, fileId: file.id, action: "open" })).status).toBe(400);
      expect(db.prepare("SELECT action, rank FROM feedback").all()).toEqual([{ action: "open", rank: 1 }]);
    } finally {
      server.close();
    }
  });

  it("answers CORS preflight for the popup only", async () => {
    const { server, port } = await startServer({ db: seeded(), embedder: null, token: "t0k", port: 0 });
    try {
      const pre = (origin: string) => fetch(`http://127.0.0.1:${port}/search`, { method: "OPTIONS", headers: { origin } });
      const ok = await pre("http://tauri.localhost");
      expect(ok.status).toBe(204);
      expect(ok.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
      const bad = await pre("https://example.com");
      expect(bad.status).toBe(403);
      expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      server.close();
    }
  });

  it("runs rerank and expansion only for deep searches", async () => {
    let loads = 0;
    let expands = 0;
    const deep = async () => {
      loads++;
      return { expand: async () => (expands++, ["banana bread"]) };
    };
    const { server, port } = await startServer({ db: seeded(), embedder: null, token: "t0k", port: 0, deep });
    try {
      const get = (qs: string) => fetch(`http://127.0.0.1:${port}/search?${qs}`, { headers: { authorization: "Bearer t0k" } }).then((r) => r.json());
      await get("q=lease");
      expect(loads + expands).toBe(0);
      const r = (await get("q=lease&deep=1")) as { deep: boolean };
      expect(r.deep).toBe(true);
      expect(expands).toBe(1); // forced even though "lease" is a strong first result
    } finally {
      server.close();
    }
  });
});

describe("learning from opens", () => {
  it("ranks a file opened for the same search higher, and bench can ignore it", async () => {
    const db = seeded();
    const emb = new HashEmbedder();
    const q = "notes lease bread";
    const before = await search(db, emb, q);
    const last = before[before.length - 1]!;
    const { queryId } = await searchWithMeta(db, emb, q, { log: true });
    recordFeedback(db, { queryId: queryId!, fileId: last.files[0]!.id, action: "open", rank: before.length });

    const after = await search(db, emb, q);
    const at = (hits: typeof before) => hits.findIndex((h) => h.paths[0] === last.paths[0]);
    expect(at(after)).toBeLessThan(at(before)); // moves up, but one open doesn't take over
    expect(after[at(after)]!.trace.opened).toMatchObject({ rank: 1, sim: 1, opens: 1 });
    const ignored = await search(db, emb, q, { useFeedback: false });
    expect(ignored.map((h) => h.paths[0])).toEqual(before.map((h) => h.paths[0]));
  });

  it("uses similar wording, not unrelated searches", async () => {
    const db = seeded();
    const emb = new HashEmbedder();
    const { queryId } = await searchWithMeta(db, emb, "rent agreement pets", { log: true });
    const lease = db.prepare("SELECT id FROM files WHERE path = '/n/lease.txt'").get() as { id: number };
    recordFeedback(db, { queryId: queryId!, fileId: lease.id, action: "open" });
    expect(openedFor(db, "pets rent agreement", await emb.embedQuery("pets rent agreement"), embeddingFingerprint(emb.spec))).toHaveLength(1);
    expect(openedFor(db, "banana", await emb.embedQuery("banana"), embeddingFingerprint(emb.spec))).toHaveLength(0);
  });
});

describe.runIf(HEAVY)("background indexer", () => {
  it("waits while the GPU is busy, then indexes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ls-idx-"));
    writeFileSync(join(root, "groceries.txt"), "eggs, milk, sourdough");
    const db = openDb(":memory:");
    const worker = new WorkerClient(defaultPython(), 60_000);
    const cfg = { ...loadDaemonConfig(join(root, "none.yaml")), roots: [root] };
    let probes = 0;
    const gpu = async () => (++probes === 1 ? 90 : 0); // busy once, then quiet
    const logs: string[] = [];
    const ix = new Indexer({ db, worker, embedder: new HashEmbedder(), cfg, log: (s) => logs.push(s), gpu, gpuCheckMs: 50 });
    await ix.run();
    worker.close();
    expect(logs).toContain("GPU busy: indexing paused");
    expect(probes).toBeGreaterThanOrEqual(2);
    const hits = await search(db, null, "sourdough");
    expect(hits[0]!.paths[0]).toMatch(/groceries\.txt$/);
    expect(ix.state).toBe("idle");
  }, 60_000);
});
