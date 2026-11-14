import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS, SCHEMA_VERSION } from "./migrations.ts";

export type DB = Database.Database;
export { FILE_STATES, SCHEMA_VERSION, type FileState } from "./migrations.ts";

/** Open (or create) the index database, load sqlite-vec, and apply pending migrations. */
export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  sqliteVec.load(db);
  migrate(db);
  return db;
}

export function migrate(db: DB): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Index schema v${current} is newer than this build (v${SCHEMA_VERSION}). Update the app.`,
    );
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    const step = db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    });
    step();
  }
  return SCHEMA_VERSION;
}

/**
 * Embedding settings that, if changed, make stored vectors incompatible.
 * Stored as a fingerprint in meta so a change is detected instead of silently mixing vectors.
 */
export interface EmbeddingSpec {
  model: string; // e.g. hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf
  dims: number;
  queryFormat: string; // template with {q}
  docFormat: string; // template with {title} and {text}
  chunkTokens: number;
  overlapTokens: number;
}

export function embeddingFingerprint(spec: EmbeddingSpec): string {
  // Stable, dependency-free hash (FNV-1a 64-bit) over the canonical JSON.
  const json = JSON.stringify(spec, Object.keys(spec).sort());
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(json)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

export type VectorTableStatus = "created" | "unchanged" | "stale";

/**
 * Make sure chunk_vecs exists for this embedding spec.
 * Returns "stale" (and recreates the table empty) when the stored fingerprint differs,
 * which means every chunk must be re-embedded.
 */
export function ensureVectorTable(db: DB, spec: EmbeddingSpec): VectorTableStatus {
  const fp = embeddingFingerprint(spec);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'embedding_fingerprint'").get() as
    | { value: string }
    | undefined;
  if (row?.value === fp) return "unchanged";

  const status: VectorTableStatus = row ? "stale" : "created";
  db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS chunk_vecs");
    db.exec(
      `CREATE VIRTUAL TABLE chunk_vecs USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${spec.dims}] distance_metric=cosine)`,
    );
    const put = db.prepare(
      "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    put.run("embedding_fingerprint", fp);
    put.run("embedding_spec", JSON.stringify(spec));
  })();
  return status;
}
