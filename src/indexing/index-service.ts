import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";

import { initialIndexingStatus, type IndexingStatus } from "../domain/indexing.js";

export { initialIndexingStatus } from "../domain/indexing.js";
export type { IndexingPhase, IndexingStatus } from "../domain/indexing.js";

/**
 * Drives the bundled `aegis-search` CLI so the local full-text index stays
 * current while the daemon runs. The CLI writes the same index directory the
 * Aegis Searcher desktop application uses, so an interactive search sees
 * everything the daemon has indexed and vice versa.
 *
 * Indexing is incremental: the CLI skips files whose mtime and size are
 * unchanged, so a pass over an already-indexed tree is cheap.
 *
 * This module reaches for the filesystem and spawns a process, so nothing the
 * sandboxed renderer imports may import it; the status shape it publishes lives
 * in `domain/indexing.ts` for exactly that reason.
 */
/** The subset of a spawned indexer this service actually reads. */
export interface IndexerProcess extends ChildProcess {
  stdout: Readable;
  stderr: Readable;
}

export interface IndexServiceOptions {
  /** Absolute path of the `aegis-search` binary, usually inside the bundled skill. */
  binaryPath: string;
  directories: readonly string[];
  extensions: readonly string[];
  intervalMs: number;
  enabled: boolean;
  onStatus: (status: IndexingStatus) => void;
  clock?: () => Date;
  /** Injected for tests so a pass can be driven without a real binary. */
  spawnProcess?: (command: string, args: readonly string[]) => IndexerProcess;
}

export class IndexService {
  readonly #options: IndexServiceOptions;
  readonly #clock: () => Date;
  readonly #spawn: NonNullable<IndexServiceOptions["spawnProcess"]>;
  #status: IndexingStatus = initialIndexingStatus();
  #timer: NodeJS.Timeout | undefined;
  #child: IndexerProcess | undefined;
  #running = false;
  #stopped = false;
  #pass: Promise<void> = Promise.resolve();

  constructor(options: IndexServiceOptions) {
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date());
    this.#spawn = options.spawnProcess
      ?? ((command, args) => spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] }) as IndexerProcess);
  }

  status(): IndexingStatus {
    return structuredClone(this.#status);
  }

  /**
   * Begins periodic indexing. Returns once the service knows whether it can run;
   * the first pass proceeds in the background so daemon startup is never blocked
   * behind a filesystem walk.
   */
  async start(): Promise<void> {
    if (!this.#options.enabled) {
      this.#emit({ ...initialIndexingStatus(), phase: "disabled", directories: [...this.#options.directories] });
      return;
    }
    if (this.#options.directories.length === 0) {
      this.#emit({
        ...initialIndexingStatus(),
        phase: "disabled",
        message: "没有配置需要索引的目录",
      });
      return;
    }
    if (!(await this.#binaryAvailable())) {
      this.#emit({
        ...initialIndexingStatus(),
        phase: "unavailable",
        directories: [...this.#options.directories],
        message: `未找到索引程序: ${this.#options.binaryPath}`,
      });
      return;
    }

    this.#emit({
      ...initialIndexingStatus(),
      phase: "idle",
      directories: [...this.#options.directories],
    });
    this.#schedule(0);
  }

  /**
   * Runs a pass now and resolves when it ends. Going through the timer would
   * return before the pass had even been created, so the pass is started here
   * directly; a pass already in flight is awaited rather than duplicated.
   */
  async runNow(): Promise<void> {
    if (this.#running) {
      await this.#pass.catch(() => undefined);
      return;
    }
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#pass = this.#runPass();
    await this.#pass.catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#child?.kill("SIGTERM");
    await this.#pass.catch(() => undefined);
  }

  async #binaryAvailable(): Promise<boolean> {
    try {
      await access(this.#options.binaryPath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  #schedule(delayMs: number): void {
    if (this.#stopped || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#pass = this.#runPass().catch(() => undefined);
    }, delayMs);
    this.#timer.unref();
  }

  async #runPass(): Promise<void> {
    if (this.#stopped || this.#running) return;
    this.#running = true;
    const startedAt = this.#clock().toISOString();
    const fresh: IndexingStatus = {
      ...this.#status,
      phase: "scanning",
      total: 0,
      processed: 0,
      failed: 0,
      skipped: 0,
      startedAt,
    };
    // A new pass starts with no current file rather than the previous one's.
    delete fresh.currentFile;
    delete fresh.message;
    this.#emit(fresh);

    try {
      await this.#spawnPass();
    } catch (error) {
      this.#emit({
        ...this.#status,
        phase: "failed",
        finishedAt: this.#clock().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#running = false;
      this.#child = undefined;
      if (!this.#stopped) {
        const nextRunAt = new Date(this.#clock().getTime() + this.#options.intervalMs).toISOString();
        this.#emit({ ...this.#status, nextRunAt });
        this.#schedule(this.#options.intervalMs);
      }
    }
  }

  #spawnPass(): Promise<void> {
    const args = [
      "index",
      ...this.#options.directories,
      "--json",
      ...(this.#options.extensions.length > 0 ? ["--ext", this.#options.extensions.join(",")] : []),
    ];
    const child = this.#spawn(this.#options.binaryPath, args);
    this.#child = child;

    return new Promise<void>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        // The CLI emits one JSON object per line; partial trailing lines wait.
        let newline = stdout.indexOf("\n");
        while (newline >= 0) {
          this.#consume(stdout.slice(0, newline));
          stdout = stdout.slice(newline + 1);
          newline = stdout.indexOf("\n");
        }
      });
      child.stderr.on("data", (chunk: string) => {
        // Keep only the tail: a failing pass should not buffer unbounded output.
        stderr = `${stderr}${chunk}`.slice(-4_096);
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (signal || this.#stopped) {
          resolve();
          return;
        }
        if (code === 0) {
          this.#emit({ ...this.#status, phase: "idle", finishedAt: this.#clock().toISOString() });
          resolve();
          return;
        }
        reject(new Error(stderr.trim() || `索引进程退出码 ${String(code)}`));
      });
    });
  }

  #consume(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const record = parsed as Record<string, unknown>;
    const type = record["type"];
    if (type !== "progress" && type !== "done") return;

    const status = record["status"];
    this.#emit({
      ...this.#status,
      phase: type === "done" ? "idle" : status === "scanning" ? "scanning" : "indexing",
      total: numeric(record["total"], this.#status.total),
      processed: numeric(record["processed"], this.#status.processed),
      failed: numeric(record["failed"], this.#status.failed),
      skipped: numeric(record["skipped"], this.#status.skipped),
      ...(typeof record["currentFile"] === "string" && record["currentFile"]
        ? { currentFile: record["currentFile"] }
        : {}),
      ...(type === "done" ? { finishedAt: this.#clock().toISOString() } : {}),
    });
  }

  #emit(status: IndexingStatus): void {
    this.#status = status;
    this.#options.onStatus(structuredClone(status));
  }
}

/** Path of the indexing binary shipped inside a bundled skill directory. */
export function bundledIndexerPath(skillPath: string): string {
  return join(skillPath, "bin", "aegis-search");
}

function numeric(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
