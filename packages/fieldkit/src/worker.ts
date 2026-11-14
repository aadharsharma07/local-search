import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

export interface ExtractPage {
  page: number | null;
  text: string;
  method: string;
}
export interface ExtractResult {
  path: string;
  kind: string;
  ok: boolean;
  pages: ExtractPage[];
  text: string;
  chars: number;
  error: string | null;
  ms: number;
  ocr_engine: string | null;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Talks to the Python extraction worker over JSON lines. A request that times out kills the
 * worker; the next request starts a fresh one. That is how a poison file is contained.
 */
export class WorkerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  restarts = 0;

  constructor(
    private python: string,
    private timeoutMs = 60_000,
  ) {
    if (!existsSync(python)) {
      throw new Error(
        `Python worker not found at ${python}. Set up worker/.venv first (see docs/FIELD-VISIT.md).`,
      );
    }
  }

  private start() {
    const proc = spawn(this.python, ["-X", "utf8", "-m", "lsworker.server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONWARNINGS: "ignore" },
    });
    createInterface({ input: proc.stdout }).on("line", (line) => {
      let msg: { id: number; ok: boolean; result?: unknown; error?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        return; // stray output from a library; ignore
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? "worker error"));
    });
    proc.stderr.on("data", () => {}); // drain; libraries print warnings here
    proc.on("exit", () => {
      if (this.proc === proc) this.proc = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("worker exited"));
        this.pending.delete(id);
      }
    });
    this.proc = proc;
  }

  request<T>(body: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<T> {
    if (!this.proc) this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.restarts++;
        this.proc?.kill();
        this.proc = null;
        reject(new Error(`timeout after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.proc!.stdin.write(JSON.stringify({ id, ...body }) + "\n");
    });
  }

  ping() {
    return this.request<{ version: string; python: string; platform: string }>({ op: "ping" }, 30_000);
  }
  engines() {
    return this.request<{ ocr: string[] }>({ op: "engines" }, 120_000);
  }
  /** Never rejects: failures come back as ok=false with an error. */
  async extract(path: string, ocr = "auto"): Promise<ExtractResult> {
    try {
      return await this.request<ExtractResult>({ op: "extract", path, ocr });
    } catch (e) {
      return {
        path, kind: "", ok: false, pages: [], text: "", chars: 0, ms: this.timeoutMs,
        error: (e as Error).message, ocr_engine: null,
      };
    }
  }

  close() {
    this.proc?.stdin.end();
    this.proc?.kill();
    this.proc = null;
  }
}
