// Model-free: builds a tiny index by hand with the HashEmbedder, then benches it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bench } from "../src/bench.ts";
import { ensureVectorTable, openDb } from "../src/db/index.ts";
import { HashEmbedder } from "../src/embed/index.ts";
import { loadTestSet } from "../src/shared/testset.ts";

describe("bench", () => {
  it("scores in-scope queries only and reports no query text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsd-bench-"));
    const docs = {
      "chair.txt": "Nordhem order: ergonomic office chair, total $189",
      "bread.txt": "Banana bread: three ripe bananas, butter, sugar, flour",
      "lease.txt": "Tenancy agreement: rent $1,650 per month, pets with consent",
    };
    const embedder = new HashEmbedder();
    const db = openDb(":memory:");
    ensureVectorTable(db, embedder.spec);
    for (const [name, text] of Object.entries(docs)) {
      const path = join(dir, name);
      writeFileSync(path, text);
      db.prepare("INSERT INTO contents(hash, text, extractor, extracted_at) VALUES (?, ?, 'test', 0)").run(name, text);
      db.prepare(
        "INSERT INTO files(path, content_hash, size, mtime, ext, kind, state, first_seen) VALUES (?, ?, 1, 0, '.txt', 'text', 'indexed', 0)",
      ).run(path, name);
      const { lastInsertRowid } = db.prepare("INSERT INTO chunks(content_hash, seq, pos, text) VALUES (?, 0, 0, ?)").run(name, text);
      db.prepare("INSERT INTO chunk_vecs(chunk_id, embedding) VALUES (?, ?)").run(
        BigInt(lastInsertRowid),
        await embedder.embedDocument(name, text),
      );
    }
    const testsetPath = join(dir, "testset.json");
    writeFileSync(
      testsetPath,
      JSON.stringify({
        queries: [
          { q: "office chair receipt", expected: ["chair.txt"] },
          { q: "banana bread", expected: ["bread.txt"] },
          { q: "how much is rent", expected: ["lease.txt"] },
          { q: "file that is not indexed", expected: ["missing.pdf"] },
        ],
      }),
    );
    const r = await bench(db, embedder, loadTestSet(testsetPath));
    expect(r.queries).toEqual({ total: 4, inScope: 3, outOfScope: 1 });
    expect(r.recallAt5).toBe(1);
    expect(r.perQuery.map((p) => p.hitAt)).toEqual([1, 1, 1]);
    expect(JSON.stringify(r)).not.toContain("banana");
    expect(r.embedder).toBe("hash-v1");
  });
});
