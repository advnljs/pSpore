import { randomUUID } from "node:crypto";

import type { RunRecord } from "../automation/types.js";
import { appendJsonLine } from "../storage/atomic.js";
import { readJsonLinesRecovering } from "../storage/jsonl.js";

export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface NotificationRecord {
  version: 1;
  id: string;
  ts: string;
  level: NotificationLevel;
  title: string;
  body: string;
  source: { kind: "agent"; sessionId: string } | { kind: "run"; runId: string; jobId?: string };
  target: { kind: "local-notification" } | { kind: "session"; sessionId: string };
}

export interface NotificationServiceOptions {
  path: string;
  recoveryDirectory: string;
  clock?: () => Date;
  idFactory?: () => string;
  onNotification?: (record: NotificationRecord) => void | Promise<void>;
  retainedRecords?: number;
}

export class NotificationService {
  readonly #path: string;
  readonly #recoveryDirectory: string;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #onNotification: NotificationServiceOptions["onNotification"];
  readonly #retainedRecords: number;
  readonly #records: NotificationRecord[] = [];
  #tail = Promise.resolve();

  constructor(options: NotificationServiceOptions) {
    this.#path = options.path;
    this.#recoveryDirectory = options.recoveryDirectory;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#onNotification = options.onNotification;
    this.#retainedRecords = options.retainedRecords ?? 200;
  }

  async initialize(): Promise<void> {
    let values: unknown[];
    try {
      values = await readJsonLinesRecovering(this.#path, this.#recoveryDirectory, this.#idFactory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") values = [];
      else throw error;
    }
    for (const [index, value] of values.entries()) {
      const record = parseNotification(value, `${this.#path}:${index + 1}`);
      this.#remember(record);
      await this.#publish(record);
    }
  }

  notify(input: {
    level: NotificationLevel;
    title: string;
    body: string;
    source: NotificationRecord["source"];
    target?: NotificationRecord["target"];
  }): Promise<NotificationRecord> {
    return this.#serialize(async () => {
      const record: NotificationRecord = {
        version: 1,
        id: this.#idFactory(),
        ts: this.#clock().toISOString(),
        level: input.level,
        title: boundedText(input.title, "notification.title", 120),
        body: boundedText(input.body, "notification.body", 4_000),
        source: structuredClone(input.source),
        target: structuredClone(input.target ?? { kind: "local-notification" }),
      };
      await appendJsonLine(this.#path, record, 0o600);
      this.#remember(record);
      await this.#publish(record);
      return structuredClone(record);
    });
  }

  async deliverRun(run: RunRecord): Promise<void> {
    if (run.delivery.kind === "none") return;
    const detail = run.reason ?? run.error ?? `Run finished with status ${run.status}`;
    await this.notify({
      level: run.status === "succeeded" ? "success" : run.status === "blocked" ? "warning" : "error",
      title: run.jobId ? `Job ${run.jobId}: ${run.status}` : `Run ${run.source}: ${run.status}`,
      body: detail,
      source: { kind: "run", runId: run.id, ...(run.jobId === undefined ? {} : { jobId: run.jobId }) },
      target:
        run.delivery.kind === "session"
          ? { kind: "session", sessionId: run.delivery.sessionId }
          : { kind: "local-notification" },
    });
  }

  list(): NotificationRecord[] {
    return this.#records.map((record) => structuredClone(record));
  }

  #remember(record: NotificationRecord): void {
    this.#records.push(structuredClone(record));
    while (this.#records.length > this.#retainedRecords) this.#records.shift();
  }

  async #publish(record: NotificationRecord): Promise<void> {
    try {
      await this.#onNotification?.(structuredClone(record));
    } catch {
      // Durable delivery remains authoritative even when an observer is unavailable.
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function parseNotification(value: unknown, path: string): NotificationRecord {
  if (!isRecord(value)) throw new Error(`Invalid notification record at ${path}`);
  const keys = new Set(["version", "id", "ts", "level", "title", "body", "source", "target"]);
  const unknown = Object.keys(value).filter((key) => !keys.has(key));
  if (unknown.length > 0) throw new Error(`Notification at ${path} contains unknown keys: ${unknown.join(", ")}`);
  if (value["version"] !== 1) throw new Error(`Notification at ${path} has unsupported version`);
  const level = value["level"];
  if (level !== "info" && level !== "success" && level !== "warning" && level !== "error") {
    throw new Error(`Notification at ${path} has invalid level`);
  }
  return {
    version: 1,
    id: boundedText(value["id"], `${path}.id`, 128),
    ts: boundedText(value["ts"], `${path}.ts`, 64),
    level,
    title: boundedText(value["title"], `${path}.title`, 120),
    body: boundedText(value["body"], `${path}.body`, 4_000),
    source: parseSource(value["source"], `${path}.source`),
    target: parseTarget(value["target"], `${path}.target`),
  };
}

function parseSource(value: unknown, path: string): NotificationRecord["source"] {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (value["kind"] === "agent" && exactKeys(value, ["kind", "sessionId"])) {
    return { kind: "agent", sessionId: boundedText(value["sessionId"], `${path}.sessionId`, 128) };
  }
  if (value["kind"] === "run" && exactKeys(value, ["kind", "runId", "jobId"], ["jobId"])) {
    const jobId = value["jobId"];
    return {
      kind: "run",
      runId: boundedText(value["runId"], `${path}.runId`, 128),
      ...(jobId === undefined ? {} : { jobId: boundedText(jobId, `${path}.jobId`, 128) }),
    };
  }
  throw new Error(`${path} has invalid source`);
}

function parseTarget(value: unknown, path: string): NotificationRecord["target"] {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (value["kind"] === "local-notification" && exactKeys(value, ["kind"])) return { kind: "local-notification" };
  if (value["kind"] === "session" && exactKeys(value, ["kind", "sessionId"])) {
    return { kind: "session", sessionId: boundedText(value["sessionId"], `${path}.sessionId`, 128) };
  }
  throw new Error(`${path} has invalid target`);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): boolean {
  const accepted = new Set(keys);
  const optionalSet = new Set(optional);
  if (Object.keys(value).some((key) => !accepted.has(key))) return false;
  if (keys.some((key) => !optionalSet.has(key) && !(key in value))) return false;
  return true;
}

function boundedText(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${path} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
