import { describe, expect, it } from "vitest";
import {
  ensureVectorTable,
  embeddingFingerprint,
  migrate,
  openDb,
  SCHEMA_VERSION,
  type EmbeddingSpec,
} from "../src/db/index.ts";

const spec: EmbeddingSpec = {
  model: "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
  dims: 4,
  queryFormat: "task: search result | query: {q}",
  docFormat: "title: {title} | text: {text}",
  chunkTokens: 900,
  overlapTokens: 135,
};

function seedFile(db: ReturnType<typeof openDb>, path: string, hash: string, text: string) {
  db.prepare(
    "INSERT OR IGNORE INTO contents(hash, text, extractor, extracted_at) VALUES (?, ?, 'test', 0)",
  ).run(hash, text);
  db.prepare(
    "INSERT INTO files(path, content_hash, size, mtime, ext, kind, state, first_seen) VALUES (?, ?, 1, 0, '.txt', 'text', 'indexed', 0)",
  ).run(path, hash);
}

describe("schema", () => {
  it("migrates a fresh database to the current version and is idempotent", () => {
    const db = openDb(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(migrate(db)).toBe(SCHEMA_VERSION);
  });

  it("refuses a database from a newer build", () => {
    const db = openDb(":memory:");
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(/newer than this build/);
  });

  it("rejects unknown lifecycle states", () => {
    const db = openDb(":memory:");
    expect(() =>
      db
        .prepare(
          "INSERT INTO files(path, size, mtime, ext, kind, state, first_seen) VALUES ('a', 1, 0, '.txt', 'text', 'bogus', 0)",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("keeps the FTS index in sync with chunks", () => {
    const db = openDb(":memory:");
    seedFile(db, "/r.txt", "h1", "Nordhem office chair receipt");
    const ins = db.prepare("INSERT INTO chunks(content_hash, seq, pos, text) VALUES ('h1', 0, 0, ?)");
    const { lastInsertRowid } = ins.run("Nordhem ergonomic office chair, total $189");
    const hit = () =>
      db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?").all("chairs") as unknown[];
    expect(hit()).toHaveLength(1); // porter stemming: chairs -> chair
    db.prepare("UPDATE chunks SET text = 'nothing relevant' WHERE id = ?").run(lastInsertRowid);
    expect(hit()).toHaveLength(0);
  });

  it("shares content between duplicate files and cascades chunk deletes", () => {
    const db = openDb(":memory:");
    seedFile(db, "/a/receipt.pdf", "same", "x");
    seedFile(db, "/b/receipt copy.pdf", "same", "x");
    db.prepare("INSERT INTO chunks(content_hash, seq, pos, text) VALUES ('same', 0, 0, 'x')").run();
    const n = db.prepare("SELECT count(*) AS n FROM contents").get() as { n: number };
    expect(n.n).toBe(1);
    db.prepare("DELETE FROM files").run();
    db.prepare("DELETE FROM contents WHERE hash = 'same'").run();
    expect((db.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n).toBe(0);
  });
});

describe("vector table", () => {
  it("creates, keeps, then flags stale when the embedding spec changes", () => {
    const db = openDb(":memory:");
    expect(ensureVectorTable(db, spec)).toBe("created");
    expect(ensureVectorTable(db, spec)).toBe("unchanged");

    db.prepare("INSERT INTO chunk_vecs(chunk_id, embedding) VALUES (?, ?)").run(
      1n,
      new Float32Array([1, 0, 0, 0]),
    );
    db.prepare("INSERT INTO chunk_vecs(chunk_id, embedding) VALUES (?, ?)").run(
      2n,
      new Float32Array([0, 1, 0, 0]),
    );
    const nearest = db
      .prepare(
        "SELECT chunk_id, distance FROM chunk_vecs WHERE embedding MATCH ? AND k = 1 ORDER BY distance",
      )
      .all(new Float32Array([0.9, 0.1, 0, 0])) as { chunk_id: number }[];
    expect(nearest[0]?.chunk_id).toBe(1);

    expect(ensureVectorTable(db, { ...spec, chunkTokens: 800 })).toBe("stale");
    expect((db.prepare("SELECT count(*) AS n FROM chunk_vecs").get() as { n: number }).n).toBe(0);
  });

  it("fingerprint ignores key order but not values", () => {
    const reordered = Object.fromEntries(Object.entries(spec).reverse()) as unknown as EmbeddingSpec;
    expect(embeddingFingerprint(reordered)).toBe(embeddingFingerprint(spec));
    expect(embeddingFingerprint({ ...spec, dims: 8 })).not.toBe(embeddingFingerprint(spec));
  });
});
