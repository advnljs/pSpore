import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import type { RootSessionMetadata } from "../domain/runtime.js";
import { atomicWriteJson } from "../storage/atomic.js";

export interface RootSessionRecord extends RootSessionMetadata {
  id: string;
  sessionFile: string;
  cwd: string;
  titleSource: "default" | "user" | "prompt";
}

interface SessionCatalogFile {
  version: 1;
  sessions: RootSessionRecord[];
}

export interface SessionCatalogOptions {
  path: string;
  sessionsRoot: string;
  workspaceId: string;
  cwd: string;
  clock?: () => Date;
}

export class SessionCatalog {
  readonly #path: string;
  readonly #sessionsRoot: string;
  readonly #workspaceId: string;
  readonly #cwd: string;
  readonly #clock: () => Date;
  #records = new Map<string, RootSessionRecord>();
  #tail: Promise<void> = Promise.resolve();

  private constructor(options: SessionCatalogOptions, sessionsRoot: string, cwd: string) {
    this.#path = options.path;
    this.#sessionsRoot = sessionsRoot;
    this.#workspaceId = options.workspaceId;
    this.#cwd = cwd;
    this.#clock = options.clock ?? (() => new Date());
  }

  static async open(options: SessionCatalogOptions): Promise<SessionCatalog> {
    const catalog = new SessionCatalog(options, await realpath(options.sessionsRoot), await realpath(options.cwd));
    await catalog.#initialize();
    return catalog;
  }

  list(): RootSessionRecord[] {
    return [...this.#records.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map((record) => structuredClone(record));
  }

  get(id: string): RootSessionRecord | undefined {
    const record = this.#records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async idle(): Promise<void> {
    await this.#tail;
  }

  async add(input: {
    id: string;
    sessionFile: string;
    cwd: string;
    title?: string;
  }): Promise<RootSessionRecord> {
    const id = sessionId(input.id, "session.id");
    const sessionFile = await this.#sessionFile(input.sessionFile);
    const cwd = await realpath(input.cwd);
    const now = this.#clock().toISOString();
    const suppliedTitle = input.title?.trim();
    const record: RootSessionRecord = {
      id,
      sessionFile,
      cwd,
      title: suppliedTitle ? boundedTitle(suppliedTitle) : defaultTitle(id),
      titleSource: suppliedTitle ? "user" : "default",
      createdAt: now,
      updatedAt: now,
    };
    await this.#mutate((next) => {
      if (next.has(id)) throw new Error(`Root session already exists: ${id}`);
      next.set(id, record);
    });
    return structuredClone(record);
  }

  async touch(id: string, options: { prompt?: string; sessionFile?: string } = {}): Promise<RootSessionRecord | undefined> {
    const existing = this.#records.get(id);
    if (!existing) return undefined;
    const nextSessionFile = options.sessionFile === undefined ? undefined : await this.#sessionFile(options.sessionFile);
    let updated: RootSessionRecord | undefined;
    await this.#mutate((records) => {
      const current = records.get(id);
      if (!current) return;
      const promptTitle = current.titleSource === "default" && options.prompt
        ? titleFromPrompt(options.prompt)
        : undefined;
      updated = {
        ...current,
        sessionFile: nextSessionFile ?? current.sessionFile,
        updatedAt: this.#clock().toISOString(),
        ...(promptTitle ? { title: promptTitle, titleSource: "prompt" as const } : {}),
      };
      records.set(id, updated);
    });
    return updated ? structuredClone(updated) : undefined;
  }

  async #initialize(): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.#path, "utf8"));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const legacy = await this.#discoverLegacy();
      if (legacy) this.#records.set(legacy.id, legacy);
      await this.#write(this.#records);
      return;
    }
    const parsed = parseCatalog(value);
    const records = new Map<string, RootSessionRecord>();
    for (const record of parsed.sessions) {
      const sessionFile = await this.#sessionFile(record.sessionFile);
      const cwd = await realpath(record.cwd);
      if (records.has(record.id)) throw new Error(`Session catalog contains duplicate id: ${record.id}`);
      records.set(record.id, { ...record, sessionFile, cwd });
    }
    this.#records = records;
  }

  async #discoverLegacy(): Promise<RootSessionRecord | undefined> {
    const directory = join(this.#sessionsRoot, this.#workspaceId);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    const candidates = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map(async (entry) => {
        const path = await this.#sessionFile(join(directory, entry.name));
        return { path, stats: await stat(path) };
      }));
    candidates.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs || left.path.localeCompare(right.path));
    const latest = candidates[0];
    if (!latest) return undefined;
    const created = latest.stats.birthtimeMs > 0 ? latest.stats.birthtime : latest.stats.mtime;
    return {
      id: "main",
      sessionFile: latest.path,
      cwd: this.#cwd,
      title: defaultTitle("main"),
      titleSource: "default",
      createdAt: created.toISOString(),
      updatedAt: latest.stats.mtime.toISOString(),
    };
  }

  async #sessionFile(path: string): Promise<string> {
    const resolved = await realpath(path);
    const rel = relative(this.#sessionsRoot, resolved);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || !resolved.endsWith(".jsonl")) {
      throw new Error(`Session file must be a JSONL file inside the session root: ${path}`);
    }
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error(`Session file is not a regular file: ${path}`);
    return resolved;
  }

  #mutate(operation: (records: Map<string, RootSessionRecord>) => void): Promise<void> {
    const task = this.#tail.then(async () => {
      const next = new Map([...this.#records].map(([id, record]) => [id, structuredClone(record)]));
      operation(next);
      await this.#write(next);
      this.#records = next;
    });
    this.#tail = task.catch(() => undefined);
    return task;
  }

  async #write(records: Map<string, RootSessionRecord>): Promise<void> {
    const file: SessionCatalogFile = {
      version: 1,
      sessions: [...records.values()]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
    };
    await atomicWriteJson(this.#path, file, 0o600);
  }
}

function parseCatalog(value: unknown): SessionCatalogFile {
  const file = object(value, "session catalog");
  exactKeys(file, ["version", "sessions"], "session catalog");
  if (file["version"] !== 1) throw new Error("Session catalog version must be 1");
  if (!Array.isArray(file["sessions"]) || file["sessions"].length > 1_000) {
    throw new Error("Session catalog sessions must be an array of at most 1000 entries");
  }
  return {
    version: 1,
    sessions: file["sessions"].map((value, index) => parseRecord(value, `session catalog.sessions[${index}]`)),
  };
}

function parseRecord(value: unknown, path: string): RootSessionRecord {
  const record = object(value, path);
  exactKeys(record, ["id", "sessionFile", "cwd", "title", "titleSource", "createdAt", "updatedAt"], path);
  const titleSource = record["titleSource"];
  if (titleSource !== "default" && titleSource !== "user" && titleSource !== "prompt") {
    throw new Error(`${path}.titleSource is invalid`);
  }
  return {
    id: sessionId(record["id"], `${path}.id`),
    sessionFile: boundedString(record["sessionFile"], `${path}.sessionFile`, 4_096),
    cwd: boundedString(record["cwd"], `${path}.cwd`, 4_096),
    title: boundedTitle(boundedString(record["title"], `${path}.title`, 120)),
    titleSource,
    createdAt: timestamp(record["createdAt"], `${path}.createdAt`),
    updatedAt: timestamp(record["updatedAt"], `${path}.updatedAt`),
  };
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expectedKeys: readonly string[], path: string): void {
  const expected = new Set(expectedKeys);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !expected.has(key));
  const missing = expectedKeys.filter((key) => !(key in value));
  if (unknown.length > 0) throw new Error(`${path} contains unknown fields: ${unknown.join(", ")}`);
  if (missing.length > 0) throw new Error(`${path} is missing fields: ${missing.join(", ")}`);
}

function sessionId(value: unknown, path: string): string {
  const id = boundedString(value, path, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new Error(`${path} contains unsupported characters`);
  return id;
}

function boundedString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${path} must be a non-empty string of at most ${maximum} characters without controls`);
  }
  return value;
}

function boundedTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 120) throw new Error("Session title must contain 1-120 characters");
  return normalized;
}

function titleFromPrompt(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const chars = [...normalized];
  return boundedTitle(chars.length > 72 ? `${chars.slice(0, 71).join("")}…` : normalized);
}

function defaultTitle(id: string): string {
  return id === "main" ? "Main session" : "New session";
}

function timestamp(value: unknown, path: string): string {
  const text = boundedString(value, path, 64);
  const date = new Date(text);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== text) throw new Error(`${path} must be an ISO timestamp`);
  return text;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
