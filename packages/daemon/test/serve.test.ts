import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultPython, loadDaemonConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { parseVariants } from "../src/embed/extras.ts";
import { HashEmbedder } from "../src/embed/index.ts";
import { search } from "../src/search/index.ts";
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
