import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { basename, normalize as normPath, sep } from "node:path";
import { ensureVectorTable, type DB } from "../db/index.ts";
import type { Embedder } from "../embed/index.ts";
import { chunkText } from "../shared/chunk.ts";
import { INDEXED_KINDS, kindFor } from "../shared/kinds.ts";
import { readOrigin } from "../shared/platform.ts";
import { emptyWalkStats, walk, type WalkStats } from "../shared/walk.ts";
import type { WorkerClient } from "../shared/worker.ts";

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface ScanOptions {
  roots: string[];
  excludeDirs: string[];
  maxBytes?: number;
  /** Returns the indexes of paths that are cloud placeholders (Windows only). */
  cloudCheck?: (paths: string[]) => Promise<Set<number>>;
  now?: number;
}

export interface ScanResult {
  seen: number;
  added: number;
  changed: number;
  restored: number;
  tombstoned: number;
  skipped: number;
  missingRoots: string[];
  walk: WalkStats;
}

const nfc = (p: string) => normPath(p).normalize("NFC");

function skipReason(ext: string, size: number, maxBytes: number, cloud: boolean): string | null {
  if (!INDEXED_KINDS.has(kindFor(ext))) return "type";
  if (size === 0) return "empty";
  if (size > maxBytes) return "too_large";
  if (cloud) return "cloud_only";
  return null;
}

interface FileRow {
  id: number;
  size: number;
  mtime: number;
  state: string;
  content_hash: string | null;
  deleted_at: number | null;
}

/**
 * Bring the files table in line with the disk. Cheap: one stat per file, no reads.
 * New and changed files are queued; files gone from a present root are tombstoned (soft delete),
 * and files under a missing root (unplugged drive) are left alone.
 */
export async function scan(db: DB, opts: ScanOptions): Promise<ScanResult> {
  const now = opts.now ?? Date.now();
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const stats: WalkStats = emptyWalkStats();
  const presentRoots: string[] = [];
  const missingRoots: string[] = [];
  const entries: { path: string; ext: string; size: number; mtime: number }[] = [];

  for (const r of opts.roots) {
    const root = nfc(r);
    if (!existsSync(root)) {
      missingRoots.push(root);
      continue;
    }
    presentRoots.push(root);
    for (const f of walk(root, opts.excludeDirs, stats)) {
      entries.push({ path: nfc(f.path), ext: f.ext, size: f.size, mtime: Math.round(f.mtimeMs) });
    }
  }
  const cloud = opts.cloudCheck ? await opts.cloudCheck(entries.map((e) => e.path)) : new Set<number>();

  const res: ScanResult = { seen: entries.length, added: 0, changed: 0, restored: 0, tombstoned: 0, skipped: 0, missingRoots, walk: stats };
  const get = db.prepare("SELECT id, size, mtime, state, content_hash, deleted_at FROM files WHERE path = ?");
  const insert = db.prepare(
    "INSERT INTO files(path, size, mtime, ext, kind, state, skip_reason, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const update = db.prepare(
    "UPDATE files SET size = ?, mtime = ?, state = ?, skip_reason = ?, error = NULL, deleted_at = NULL WHERE id = ?",
  );
  const seen = new Set<string>();

  db.transaction(() => {
    entries.forEach((e, i) => {
      seen.add(e.path);
      const reason = skipReason(e.ext, e.size, maxBytes, cloud.has(i));
      if (reason) res.skipped++;
      const row = get.get(e.path) as FileRow | undefined;
      if (!row) {
        insert.run(e.path, e.size, e.mtime, e.ext, kindFor(e.ext), reason ? "skipped" : "queued", reason, now);
        res.added++;
        return;
      }
      const same = row.size === e.size && row.mtime === e.mtime;
      if (same && row.deleted_at === null && !(row.state === "skipped" && !reason)) return;
      if (same && row.deleted_at !== null) {
        // Came back unchanged (e.g. drive plugged in again): keep its index entry.
        const state = reason ? "skipped" : row.content_hash ? "indexed" : "queued";
        update.run(e.size, e.mtime, state, reason, row.id);
        res.restored++;
        return;
      }
      const state = reason ? "skipped" : row.content_hash ? "stale" : "queued";
      update.run(e.size, e.mtime, state, reason, row.id);
      res.changed++;
    });

    // Tombstone files that vanished from roots we could read.
    const live = db.prepare("SELECT id, path FROM files WHERE deleted_at IS NULL").all() as { id: number; path: string }[];
    const tomb = db.prepare("UPDATE files SET deleted_at = ?, state = 'tombstoned' WHERE id = ?");
    for (const f of live) {
      if (seen.has(f.path)) continue;
      if (!presentRoots.some((r) => f.path === r || f.path.startsWith(r.endsWith(sep) ? r : r + sep))) continue;
      tomb.run(now, f.id);
      res.tombstoned++;
    }
  })();
  return res;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

/** Delete a content row (and its chunks and vectors) once no file points at it. */
export function gcContent(db: DB, hash: string): boolean {
  const used = db.prepare("SELECT 1 FROM files WHERE content_hash = ? LIMIT 1").get(hash);
  if (used) return false;
  const ids = db.prepare("SELECT id FROM chunks WHERE content_hash = ?").all(hash) as { id: number }[];
  const hasVec = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chunk_vecs'").get();
  if (hasVec) {
    const del = db.prepare("DELETE FROM chunk_vecs WHERE chunk_id = ?");
    for (const { id } of ids) del.run(BigInt(id));
  }
  db.prepare("DELETE FROM contents WHERE hash = ?").run(hash);
  return true;
}

/** Embed every chunk that has no vector yet (new chunks, or all of them after a model change). */
export async function embedMissing(db: DB, embedder: Embedder, onProgress?: (done: number) => void): Promise<number> {
  const rows = db
    .prepare(
      `SELECT c.id, c.text, (SELECT path FROM files f WHERE f.content_hash = c.content_hash LIMIT 1) AS path
       FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM chunk_vecs v WHERE v.chunk_id = c.id)`,
    )
    .all() as { id: number; text: string; path: string | null }[];
  const ins = db.prepare("INSERT INTO chunk_vecs(chunk_id, embedding) VALUES (?, ?)");
  let n = 0;
  for (const r of rows) {
    const v = await embedder.embedDocument(r.path ? basename(r.path) : "", r.text);
    ins.run(BigInt(r.id), v);
    if (++n % 50 === 0) onProgress?.(n);
  }
  return n;
}

export interface ProcessOptions {
  worker: WorkerClient;
  embedder: Embedder;
  ocr?: string;
  batch?: number;
  limit?: number; // stop after this many files (for idle-time slices)
  onFile?: (path: string, state: string) => void;
}

export interface ProcessResult {
  indexed: number;
  linked: number; // same content already indexed (duplicates, renames)
  failed: number;
  reembedded: number;
}

/**
 * Work through queued and stale files: hash, link duplicates, extract, chunk, embed.
 * A file reaches 'indexed' only after its text, keywords and vectors are all stored.
 */
export async function processQueue(db: DB, opts: ProcessOptions): Promise<ProcessResult> {
  const res: ProcessResult = { indexed: 0, linked: 0, failed: 0, reembedded: 0 };
  if (ensureVectorTable(db, opts.embedder.spec) === "stale") {
    res.reembedded = await embedMissing(db, opts.embedder);
  }
  const next = db.prepare(
    "SELECT id, path, content_hash FROM files WHERE state IN ('queued', 'stale') AND deleted_at IS NULL ORDER BY id LIMIT ?",
  );
  const setState = db.prepare("UPDATE files SET state = ?, error = ? WHERE id = ?");
  const hasContent = db.prepare("SELECT 1 FROM contents WHERE hash = ?");
  const link = db.prepare("UPDATE files SET content_hash = ?, origin_url = ?, state = 'indexed', error = NULL WHERE id = ?");
  const putContent = db.prepare(
    "INSERT INTO contents(hash, text, extractor, content_date, extracted_at) VALUES (?, ?, ?, ?, ?)",
  );
  const putChunk = db.prepare("INSERT INTO chunks(content_hash, seq, pos, page, text) VALUES (?, ?, ?, ?, ?)");
  const putVec = db.prepare("INSERT INTO chunk_vecs(chunk_id, embedding) VALUES (?, ?)");
  const batch = opts.batch ?? 50;
  let processed = 0;

  for (;;) {
    const rows = next.all(batch) as { id: number; path: string; content_hash: string | null }[];
    if (!rows.length) break;
    for (const f of rows) {
      if (opts.limit !== undefined && processed >= opts.limit) return res;
      processed++;
      const old = f.content_hash;
      const fail = (err: string) => {
        db.transaction(() => {
          db.prepare("UPDATE files SET state = 'failed', error = ?, content_hash = NULL WHERE id = ?").run(err.slice(0, 500), f.id);
          if (old) gcContent(db, old);
        })();
        res.failed++;
        opts.onFile?.(f.path, "failed");
      };
      setState.run("extracting", null, f.id);

      let hash: string;
      try {
        hash = await sha256File(f.path);
      } catch (e) {
        fail(`read: ${(e as Error).message}`);
        continue;
      }
      const origin = readOrigin(f.path);
      const originUrl = origin?.hostUrl ?? origin?.referrerUrl ?? null;

      if (hasContent.get(hash)) {
        db.transaction(() => {
          link.run(hash, originUrl, f.id);
          if (old && old !== hash) gcContent(db, old);
        })();
        res.linked++;
        opts.onFile?.(f.path, "indexed");
        continue;
      }

      const r = await opts.worker.extract(f.path, opts.ocr ?? "auto");
      if (!r.ok) {
        fail(r.error ?? "extraction failed");
        continue;
      }
      // Chunk page by page so every chunk knows its page number.
      const pieces: { page: number | null; pos: number; text: string }[] = [];
      let offset = 0;
      for (const p of r.pages) {
        if (!p.text) continue; // r.text joins only non-empty pages, so empty ones take no space
        for (const c of chunkText(p.text)) pieces.push({ page: p.page, pos: offset + c.pos, text: c.text });
        offset += p.text.length + 2;
      }
      let vectors: Float32Array[];
      try {
        vectors = [];
        for (const p of pieces) vectors.push(await opts.embedder.embedDocument(basename(f.path), p.text));
      } catch (e) {
        fail(`embed: ${(e as Error).message}`);
        continue;
      }
      db.transaction(() => {
        putContent.run(hash, r.text, `lsworker ${r.ocr_engine ? `+ocr:${r.ocr_engine}` : ""}`.trim(), r.content_date ?? null, Date.now());
        pieces.forEach((p, seq) => {
          const { lastInsertRowid } = putChunk.run(hash, seq, p.pos, p.page, p.text);
          putVec.run(BigInt(lastInsertRowid), vectors[seq]!);
        });
        link.run(hash, originUrl, f.id);
        if (old && old !== hash) gcContent(db, old);
      })();
      res.indexed++;
      opts.onFile?.(f.path, "indexed");
    }
  }
  return res;
}

export function stateCounts(db: DB): Record<string, number> {
  const rows = db.prepare("SELECT state, count(*) AS n FROM files GROUP BY state").all() as { state: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}
