import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { watch, writeFileSync, type FSWatcher } from "node:fs";
import { createServer, type Server } from "node:http";
import { constants, setPriority } from "node:os";
import { join } from "node:path";
import { DATA_DIR, type DaemonConfig } from "./config.ts";
import type { DB } from "./db/index.ts";
import type { Embedder } from "./embed/index.ts";
import { processQueue, scan, stateCounts } from "./ingest/index.ts";
import { search, type SearchOptions } from "./search/index.ts";
import type { WorkerClient } from "./shared/worker.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sum of "GPU Engine ... 3D" utilization in Get-Counter output, ignoring one process. */
export function parseGpuCounters(out: string, ignorePid: number): number {
  let sum = 0;
  for (const line of out.split(/\r?\n/)) {
    const m = /^(.*?)\t([\d.]+)$/.exec(line.trim());
    if (!m || m[1]!.includes(`pid_${ignorePid}_`)) continue;
    sum += Number(m[2]);
  }
  return sum;
}

/**
 * 3D-engine utilization of everything except this process, in percent (Windows performance
 * counters; ~0.3 s per call). Elsewhere it reports 0, so indexing never pauses.
 */
export function gpuUsage(ignorePid = process.pid): Promise<number> {
  if (process.platform !== "win32") return Promise.resolve(0);
  const script =
    "(Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples | " +
    'ForEach-Object { "$($_.InstanceName)`t$($_.CookedValue)" }';
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15_000 }, (err, out) =>
      resolve(err ? 0 : parseGpuCounters(out, ignorePid)),
    );
  });
}

export interface IndexerOptions {
  db: DB;
  worker: WorkerClient;
  embedder: Embedder;
  cfg: DaemonConfig;
  log: (s: string) => void;
  /** Pause while other programs use more than this much of the GPU's 3D engine (percent). */
  gpuBusyPercent?: number;
  gpuCheckMs?: number;
  rescanMs?: number;
  /** For tests: replaces the GPU probe. */
  gpu?: () => Promise<number>;
}

/**
 * Background indexing: scan at start, on file changes (debounced) and hourly; process the queue
 * in small slices at below-normal priority, pausing while the GPU is busy (games, video).
 */
export class Indexer {
  state: "idle" | "scanning" | "indexing" | "paused" = "idle";
  private running = false;
  private again = false;
  private watchers: FSWatcher[] = [];
  private timers: NodeJS.Timeout[] = [];
  private lastGpu = { at: 0, busy: false };

  constructor(private o: IndexerOptions) {}

  start() {
    try {
      setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      /* not permitted: keep normal priority */
    }
    let debounce: NodeJS.Timeout | undefined;
    for (const root of this.o.cfg.roots) {
      try {
        this.watchers.push(
          watch(root, { recursive: true }, () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => void this.run(), 10_000);
          }),
        );
      } catch {
        /* missing root: the periodic rescan picks it up when it appears */
      }
    }
    this.timers.push(setInterval(() => void this.run(), this.o.rescanMs ?? 3_600_000));
    void this.run();
  }

  stop() {
    for (const w of this.watchers) w.close();
    for (const t of this.timers) clearInterval(t);
  }

  private async gpuBusy(): Promise<boolean> {
    const every = this.o.gpuCheckMs ?? 30_000;
    if (Date.now() - this.lastGpu.at < every) return this.lastGpu.busy;
    const use = await (this.o.gpu ?? gpuUsage)();
    this.lastGpu = { at: Date.now(), busy: use > (this.o.gpuBusyPercent ?? 30) };
    return this.lastGpu.busy;
  }

  /** One scan-and-index pass; a request during a pass schedules one more pass. */
  async run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        this.state = "scanning";
        const { db, worker, embedder, cfg, log } = this.o;
        const cloudCheck = process.platform === "win32" ? (p: string[]) => worker.cloudCheck(p) : undefined;
        const s = await scan(db, { roots: cfg.roots, excludeDirs: cfg.excludeDirs, cloudCheck });
        if (s.added || s.changed || s.tombstoned) log(`scan: ${s.added} new · ${s.changed} changed · ${s.tombstoned} removed`);
        for (;;) {
          if (await this.gpuBusy()) {
            if (this.state !== "paused") log("GPU busy: indexing paused");
            this.state = "paused";
            await sleep(this.o.gpuCheckMs ?? 30_000);
            continue;
          }
          this.state = "indexing";
          const r = await processQueue(db, { worker, embedder, limit: 10 });
          const done = r.indexed + r.linked + r.failed;
          if (done) log(`indexed ${r.indexed} · linked ${r.linked} · failed ${r.failed}`);
          if (done < 10) break;
        }
      } while (this.again);
    } catch (e) {
      this.o.log(`indexer error: ${(e as Error).message}`);
    } finally {
      this.state = "idle";
      this.running = false;
    }
  }
}

export interface ServeOptions {
  db: DB;
  embedder: Embedder | null;
  token: string;
  port: number;
  indexer?: Indexer;
  searchOpts?: Pick<SearchOptions, "rerank" | "expand">;
}

/** Localhost API: GET /search?q=&n=, GET /status, POST /reindex. Bearer token required. */
export function startServer(o: ServeOptions): Promise<{ server: Server; port: number }> {
  const server = createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${o.token}`) return send(401, { error: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/search") {
        const q = url.searchParams.get("q")?.trim();
        if (!q) return send(400, { error: "missing q" });
        const t0 = performance.now();
        const n = Math.min(50, Math.max(1, Number(url.searchParams.get("n")) || 10));
        const hits = await search(o.db, o.embedder, q, { limit: n, log: true, ...o.searchOpts });
        return send(200, { q, ms: Math.round(performance.now() - t0), hits });
      }
      if (req.method === "GET" && url.pathname === "/status") {
        return send(200, { files: stateCounts(o.db), indexer: o.indexer?.state ?? "off" });
      }
      if (req.method === "POST" && url.pathname === "/reindex") {
        void o.indexer?.run();
        return send(202, { ok: true });
      }
      return send(404, { error: "not found" });
    } catch (e) {
      return send(500, { error: (e as Error).message });
    }
  });
  return new Promise((resolve) => server.listen(o.port, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port })));
}

/** A fresh random token, written where local clients (the popup) can read it. */
export function writeToken(dir = DATA_DIR): string {
  const token = randomBytes(24).toString("hex");
  writeFileSync(join(dir, "token"), token, { mode: 0o600 });
  return token;
}
