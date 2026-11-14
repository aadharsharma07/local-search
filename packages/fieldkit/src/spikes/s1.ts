import type { FieldkitConfig } from "../config.ts";
import type { SpikeResult } from "../report.ts";
import { WorkerClient } from "@local-search/daemon/shared/worker";

type Check = { ok: boolean; detail: string };

async function check(fn: () => Promise<string> | string): Promise<Check> {
  try {
    return { ok: true, detail: await fn() };
  } catch (e) {
    return { ok: false, detail: (e as Error).message.slice(0, 500) };
  }
}

/** S1: every native dependency installs and loads on this machine. */
export async function s1(cfg: FieldkitConfig): Promise<Omit<SpikeResult, "id" | "title" | "ms">> {
  const checks: Record<string, Check> = {};

  checks["better-sqlite3 + FTS5"] = await check(async () => {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='porter unicode61'); INSERT INTO t VALUES ('office chairs');");
    const n = db.prepare("SELECT count(*) AS n FROM t WHERE t MATCH 'chair'").get() as { n: number };
    if (n.n !== 1) throw new Error("FTS5 porter stemming did not match");
    return `sqlite ${(db.prepare("select sqlite_version() v").get() as { v: string }).v}`;
  });

  checks["sqlite-vec"] = await check(async () => {
    const { default: Database } = await import("better-sqlite3");
    const vec = await import("sqlite-vec");
    const db = new Database(":memory:");
    vec.load(db);
    db.exec("CREATE VIRTUAL TABLE v USING vec0(id INTEGER PRIMARY KEY, e float[3] distance_metric=cosine)");
    db.prepare("INSERT INTO v VALUES (?, ?)").run(1n, new Float32Array([1, 0, 0]));
    const r = db.prepare("SELECT id FROM v WHERE e MATCH ? AND k = 1").get(new Float32Array([1, 0.1, 0])) as { id: number };
    if (r.id !== 1) throw new Error("KNN query returned the wrong row");
    return `vec ${(db.prepare("select vec_version() v").get() as { v: string }).v}`;
  });

  checks["node-llama-cpp"] = await check(async () => {
    const { gpuInfo } = await import("../models.ts");
    const g = await gpuInfo();
    return `backend ${g.backend}; ${g.devices.join(", ") || "no GPU device"}; VRAM ${g.vramTotalGb} GB`;
  });

  checks["onnxruntime-node (Laya runtime)"] = await check(async () => {
    const ort = await import("onnxruntime-node");
    return `onnxruntime ${(ort as unknown as { env: { versions?: { common?: string } } }).env.versions?.common ?? "loaded"}`;
  });

  checks["python worker"] = await check(async () => {
    const w = new WorkerClient(cfg.python, cfg.extractTimeoutMs);
    try {
      const p = await w.ping();
      const e = await w.engines();
      return `python ${p.python} on ${p.platform}; OCR engines: ${e.ocr.join(", ") || "none"}`;
    } finally {
      w.close();
    }
  });

  const failed = Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k);
  return {
    verdict: failed.length ? "FAIL" : "PASS",
    summary: failed.length
      ? `Failed: ${failed.join(", ")}`
      : Object.entries(checks).map(([k, c]) => `${k.split(" ")[0]}: ${c.detail.split(";")[0]}`).join(" · "),
    data: checks,
  };
}
