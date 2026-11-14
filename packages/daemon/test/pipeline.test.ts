// End-to-end ingest and search over a copy of the fixture corpus, with the real Python worker and
// the no-model HashEmbedder. Runs in CI; needs worker/.venv.
import { cpSync, existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultPython, REPO_ROOT } from "../src/config.ts";
import { openDb, type DB } from "../src/db/index.ts";
import { HashEmbedder } from "../src/embed/index.ts";
import { processQueue, scan, stateCounts } from "../src/ingest/index.ts";
import { search } from "../src/search/index.ts";
import { WorkerClient } from "../src/shared/worker.ts";

const python = defaultPython();
const run = existsSync(python) ? describe : describe.skip;

run("ingest + search pipeline", () => {
  let dir: string;
  let root: string;
  let db: DB;
  let worker: WorkerClient;
  const embedder = new HashEmbedder();
  const opts = () => ({ roots: [root], excludeDirs: ["node_modules"] });
  const process = () => processQueue(db, { worker, embedder });
  const top = async (q: string) => (await search(db, embedder, q))[0]?.paths ?? [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "lsd-pipe-"));
    root = join(dir, "corpus");
    cpSync(join(REPO_ROOT, "fixtures", "corpus"), root, { recursive: true });
    db = openDb(join(dir, "index.sqlite"));
    worker = new WorkerClient(python, 120_000);
    await scan(db, opts());
    await process();
  }, 600_000);

  afterAll(() => {
    worker?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("indexes every fixture, fails only the corrupt PDF, and shares duplicate content", () => {
    const counts = stateCounts(db);
    expect(counts.failed).toBe(1);
    expect(counts.indexed).toBe(14);
    const failed = db.prepare("SELECT path, error FROM files WHERE state = 'failed'").get() as { path: string; error: string };
    expect(failed.path).toMatch(/broken-statement\.pdf$/);
    const dup = db
      .prepare("SELECT count(DISTINCT content_hash) AS n, count(*) AS f FROM files WHERE path LIKE '%nordhem-order-88123.pdf'")
      .get() as { n: number; f: number };
    expect(dup).toEqual({ n: 1, f: 2 });
    const missingVecs = db
      .prepare("SELECT count(*) AS n FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM chunk_vecs v WHERE v.chunk_id = c.id)")
      .get() as { n: number };
    expect(missingVecs.n).toBe(0);
  });

  it("keeps page numbers for PDF chunks", () => {
    const pages = db
      .prepare("SELECT c.page FROM chunks c JOIN files f ON f.content_hash = c.content_hash WHERE f.path LIKE '%lease.pdf' ORDER BY c.seq")
      .all() as { page: number }[];
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
  });

  it("finds files by content, by name, and through OCR", async () => {
    expect((await top("banana bread recipe"))[0]).toMatch(/banana bread\.txt$/);
    expect((await top("security deposit pets"))[0]).toMatch(/lease\.pdf$/);
    expect((await top("fuzzy match"))[0]).toMatch(/fuzzy_match\.py$/);
    expect((await top("Lakeview Power statement"))[0]).toMatch(/scan-2024-01-0007\.pdf$/);
    expect((await top("QX7P2L"))[0]).toMatch(/Screenshot 2025-05-11 213344\.png$/);
  });

  it("returns duplicates as one hit with every path, and explains the score", async () => {
    const [hit] = await search(db, embedder, "Nordhem ergonomic office chair");
    expect(hit!.paths).toHaveLength(2);
    expect(hit!.trace.keyword?.rank).toBe(1);
    expect(hit!.snippet.toLowerCase()).toContain("chair");
  });

  it("does nothing on a rescan of an unchanged tree", async () => {
    const s = await scan(db, opts());
    expect([s.added, s.changed, s.tombstoned]).toEqual([0, 0, 0]);
    const r = await process();
    expect(r.indexed + r.linked + r.failed).toBe(0);
  });

  it("re-indexes a changed file and drops its old content", async () => {
    const f = join(root, "Documents", "Notes", "banana bread.txt");
    writeFileSync(f, "Zucchini muffins: 2 cups grated zucchini, 1 cup sugar.\n");
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    const s = await scan(db, opts());
    expect(s.changed).toBe(1);
    await process();
    expect((await top("zucchini muffins"))[0]).toMatch(/banana bread\.txt$/);
    const old = db.prepare("SELECT count(*) AS n FROM chunks WHERE text LIKE '%ripe bananas%'").get() as { n: number };
    expect(old.n).toBe(0);
  });

  it("tombstones deleted files, keeps content shared with a duplicate, and restores on return", async () => {
    const a = join(root, "Downloads", "nordhem-order-88123.pdf");
    const backup = join(dir, "receipt.bak");
    cpSync(a, backup, { preserveTimestamps: true });
    rmSync(a);
    expect((await scan(db, opts())).tombstoned).toBe(1);
    const [hit] = await search(db, embedder, "Nordhem ergonomic office chair");
    expect(hit!.paths).toHaveLength(1);
    cpSync(backup, a, { preserveTimestamps: true });
    expect((await scan(db, opts())).restored).toBe(1);
    expect(stateCounts(db).tombstoned ?? 0).toBe(0);
  });

  it("leaves a missing root untouched", async () => {
    const s = await scan(db, { roots: [join(dir, "unplugged-drive"), root], excludeDirs: [] });
    expect(s.missingRoots).toHaveLength(1);
    expect(s.tombstoned).toBe(0);
  });
});
