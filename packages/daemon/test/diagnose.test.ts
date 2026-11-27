import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.ts";
import { appendTests, suggestTests, why } from "../src/diagnose.ts";
import { recordFeedback } from "../src/search/feedback.ts";
import { searchWithMeta } from "../src/search/index.ts";

function seeded() {
  const db = openDb(":memory:");
  const add = (path: string, text: string | null, kind = "text") => {
    if (text !== null) {
      db.prepare("INSERT INTO contents(hash, text, extractor, extracted_at) VALUES (?, ?, 'lsworker/0.3.0 image', 0)").run(path, text);
      db.prepare("INSERT INTO chunks(content_hash, seq, pos, text) VALUES (?, 0, 0, ?)").run(path, text);
    }
    db.prepare(
      "INSERT INTO files(path, content_hash, size, mtime, ext, kind, state, first_seen) VALUES (?, ?, 1, 0, '.png', ?, 'indexed', 0)",
    ).run(path, text === null ? null : path, kind);
  };
  add("/p/lease.txt", "Lease agreement. Rent is due on the first.");
  add("/p/IMG_0412.png", "Image: PNG, 800x600, landscape.", "image");
  add("/p/menu.txt", "Cafe menu: espresso, scones.");
  return db;
}

describe("lsd why", () => {
  it("explains a miss: text found, rank in each list", async () => {
    const db = seeded();
    const r = await why(db, null, "drawing of a dragon", "/p/IMG_0412.png");
    expect(r.file).toMatchObject({ state: "indexed", kind: "image" });
    expect(r.content).toMatchObject({ extractor: "lsworker/0.3.0 image", chunks: 1 });
    expect(r.position).toBeNull(); // nothing in its text or name matches
    const hit = await why(db, null, "rent lease", "/p/lease.txt");
    expect(hit.position).toBe(1);
    expect(hit.trace?.keyword?.rank).toBe(1);
    expect((await why(db, null, "x", "/p/missing.txt")).file).toBeNull();
  });
});

describe("lsd testset suggest", () => {
  it("proposes opened results not already in the test set, and appends accepted ones", async () => {
    const db = seeded();
    const open = async (q: string, path: string) => {
      const { queryId } = await searchWithMeta(db, null, q, { log: true });
      const f = db.prepare("SELECT id FROM files WHERE path = ?").get(path) as { id: number };
      recordFeedback(db, { queryId: queryId!, fileId: f.id, action: "open" });
    };
    await open("cafe menu", "/p/menu.txt");
    await open("Cafe  Menu", "/p/menu.txt");
    await open("my lease", "/p/lease.txt");
    const s = suggestTests(db, [{ q: "my lease", expected: ["/p/lease.txt"] }]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ path: "/p/menu.txt", opens: 2 });

    const file = join(mkdtempSync(join(tmpdir(), "lsd-ts-")), "testset.json");
    writeFileSync(file, JSON.stringify({ root: "C:\\Users\\x", queries: [{ q: "my lease", expected: ["lease.txt"] }] }));
    appendTests(file, s);
    const out = JSON.parse(readFileSync(file, "utf8"));
    expect(out.root).toBe("C:\\Users\\x");
    expect(out.queries).toHaveLength(2);
    expect(out.queries[1]).toEqual({ q: s[0]!.q, expected: ["/p/menu.txt"] });
  });
});
