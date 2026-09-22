import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import { atomicWriteFile, atomicWriteJson } from "../storage/atomic.js";
import { articleChangeCounts, diffArticleBlocks } from "./diff.js";

/** `art_` plus 12 hex characters. Short enough to say, long enough not to guess. */
export const ARTICLE_ID_PATTERN = /^art_[a-f0-9]{12}$/;

/** A long article, not a book. Past this the tool asks for a tighter draft. */
export const MAX_ARTICLE_CHARS = 400_000;

/** Versions kept for one article. Each one is a full snapshot so any of them can be reopened. */
export const MAX_ARTICLE_VERSIONS = 100;

const NUL = /\u0000/g;

export interface ArticleVersionInfo {
  version: number;
  createdAt: string;
  chars: number;
  sha256: string;
}

export interface ArticleSummary {
  id: string;
  title: string;
  sessionId: string;
  version: number;
  chars: number;
  updatedAt: string;
}

export interface ArticleCommit {
  id: string;
  title: string;
  version: number;
  chars: number;
  added: number;
  removed: number;
  /** Unchanged content reuses the current version instead of appending an empty one. */
  unchanged: boolean;
  path: string;
}

export interface ArticleDocument {
  id: string;
  title: string;
  sessionId: string;
  version: number;
  versions: readonly ArticleVersionInfo[];
  offset: number;
  length: number;
  text: string;
}

interface ArticleRecord {
  id: string;
  title: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  versions: ArticleVersionInfo[];
}

export interface ArticleEdit {
  find: string;
  replace: string;
}

export class ArticleStore {
  readonly #root: string;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;

  constructor(root: string, clock: () => Date = () => new Date(), idFactory?: () => string) {
    this.#root = root;
    this.#clock = clock;
    this.#idFactory = idFactory ?? (() => `art_${randomBytes(6).toString("hex")}`);
  }

  get root(): string {
    return this.#root;
  }

  async ready(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
  }

  async create(input: { sessionId: string; title: string; content: string }): Promise<ArticleCommit> {
    const title = cleanTitle(input.title);
    const content = cleanContent(input.content);
    await this.ready();
    const id = await this.#freshId();
    const now = this.#clock().toISOString();
    const version = versionInfo(1, content, now);
    const record: ArticleRecord = {
      id,
      title,
      sessionId: input.sessionId,
      createdAt: now,
      updatedAt: now,
      versions: [version],
    };
    const path = await this.#writeVersion(record, content);
    return commitOf(record, content, path, { added: diffArticleBlocks("", content).filter((block) => block.kind === "add").length, removed: 0, unchanged: false });
  }

  async update(input: {
    sessionId: string;
    id: string;
    title?: string;
    content?: string;
    edits?: readonly ArticleEdit[];
  }): Promise<ArticleCommit> {
    const current = await this.#load(input.id);
    if (!current || current.record.sessionId !== input.sessionId) {
      throw new Error(`No article ${input.id} in this session. Create one, or read the id from the previous article result.`);
    }
    const base = input.content === undefined ? current.content : cleanContent(input.content);
    const next = input.edits && input.edits.length > 0 ? applyEdits(base, input.edits) : base;
    const content = cleanContent(next);
    const title = input.title === undefined ? current.record.title : cleanTitle(input.title);
    if (content === current.content && title === current.record.title) {
      return commitOf(current.record, content, await this.#contained(input.id, "current.md"), { added: 0, removed: 0, unchanged: true });
    }
    if (current.record.versions.length >= MAX_ARTICLE_VERSIONS) {
      throw new Error(`Article ${input.id} already has ${MAX_ARTICLE_VERSIONS} versions. Create a new article for the next draft.`);
    }
    const counts = articleChangeCounts(diffArticleBlocks(current.content, content));
    const now = this.#clock().toISOString();
    const version = versionInfo(current.record.versions.length + 1, content, now);
    const record: ArticleRecord = {
      ...current.record,
      title,
      updatedAt: now,
      versions: [...current.record.versions, version],
    };
    const path = await this.#writeVersion(record, content);
    return commitOf(record, content, path, { ...counts, unchanged: false });
  }

  async read(input: {
    sessionId: string;
    id: string;
    version?: number;
    offset?: number;
    limit: number;
  }): Promise<ArticleDocument | undefined> {
    const loaded = await this.#load(input.id, input.version);
    if (!loaded || loaded.record.sessionId !== input.sessionId) return undefined;
    const offset = Math.min(Math.max(0, input.offset ?? 0), loaded.content.length);
    const limit = Math.max(0, input.limit);
    return {
      id: loaded.record.id,
      title: loaded.record.title,
      sessionId: loaded.record.sessionId,
      version: loaded.version,
      versions: loaded.record.versions,
      offset,
      length: loaded.content.length,
      text: loaded.content.slice(offset, offset + limit),
    };
  }

  /** Absolute path of one immutable version file, after it has been checked to stay inside the store. */
  async versionPath(id: string, version: number): Promise<string> {
    const file = await this.#versionFile(id, version);
    await readFile(file);
    return file;
  }

  async readVersion(id: string, version?: number): Promise<{ title: string; version: number; content: string } | undefined> {
    const loaded = await this.#load(id, version);
    if (!loaded) return undefined;
    return { title: loaded.record.title, version: loaded.version, content: loaded.content };
  }

  async list(sessionId: string): Promise<ArticleSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.#root);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const summaries: ArticleSummary[] = [];
    for (const name of names) {
      if (!ARTICLE_ID_PATTERN.test(name)) continue;
      const loaded = await this.#load(name);
      if (!loaded || loaded.record.sessionId !== sessionId) continue;
      const latest = loaded.record.versions.at(-1);
      if (!latest) continue;
      summaries.push({
        id: loaded.record.id,
        title: loaded.record.title,
        sessionId: loaded.record.sessionId,
        version: latest.version,
        chars: latest.chars,
        updatedAt: loaded.record.updatedAt,
      });
    }
    summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
    return summaries.slice(0, 40);
  }

  async #freshId(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.#idFactory();
      if (!ARTICLE_ID_PATTERN.test(id)) throw new Error("Article id factory produced an invalid id");
      try {
        await lstat(join(this.#root, id));
      } catch (error) {
        if (isMissing(error)) return id;
        throw error;
      }
    }
    throw new Error("Could not allocate an article id");
  }

  async #writeVersion(record: ArticleRecord, content: string): Promise<string> {
    const directory = await this.#directory(record.id, true);
    const latest = record.versions.at(-1);
    if (!latest) throw new Error("Article record has no version");
    const file = join(directory, versionName(latest.version));
    const current = join(directory, "current.md");
    await atomicWriteFile(file, content, 0o600);
    await atomicWriteFile(current, content, 0o600);
    await atomicWriteJson(join(directory, "meta.json"), record, 0o600);
    return current;
  }

  async #load(id: string, version?: number): Promise<{ record: ArticleRecord; content: string; version: number } | undefined> {
    if (!ARTICLE_ID_PATTERN.test(id)) return undefined;
    let metaRaw: string;
    try {
      metaRaw = await readFile(await this.#contained(id, "meta.json"), "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const record = parseRecord(metaRaw, id);
    if (!record) return undefined;
    const chosen = version ?? record.versions.at(-1)?.version;
    if (chosen === undefined || !record.versions.some((entry) => entry.version === chosen)) return undefined;
    try {
      const content = await readFile(await this.#versionFile(id, chosen), "utf8");
      return { record, content, version: chosen };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async #versionFile(id: string, version: number): Promise<string> {
    if (!Number.isInteger(version) || version < 1 || version > MAX_ARTICLE_VERSIONS) {
      throw new Error("Article version is out of range");
    }
    return this.#contained(id, versionName(version));
  }

  async #directory(id: string, create: boolean): Promise<string> {
    if (!ARTICLE_ID_PATTERN.test(id)) throw new Error("Article id is invalid");
    const root = await realpath(this.#root);
    const directory = join(root, id);
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const resolved = await realpath(directory);
    if (!isInside(root, resolved)) throw new Error("Article directory escaped the store");
    return resolved;
  }

  async #contained(id: string, name: string): Promise<string> {
    if (name.includes("/") || name.includes("\\") || name.includes("\0")) throw new Error("Article file name is invalid");
    const directory = await this.#directory(id, false);
    const file = join(directory, name);
    const resolved = await realpath(file);
    if (!isInside(directory, resolved)) throw new Error("Article file escaped the store");
    return resolved;
  }
}

function commitOf(
  record: ArticleRecord,
  content: string,
  path: string,
  change: { added: number; removed: number; unchanged: boolean },
): ArticleCommit {
  const latest = record.versions.at(-1);
  return {
    id: record.id,
    title: record.title,
    version: latest?.version ?? 1,
    chars: content.length,
    added: change.added,
    removed: change.removed,
    unchanged: change.unchanged,
    path,
  };
}

function versionInfo(version: number, content: string, createdAt: string): ArticleVersionInfo {
  return {
    version,
    createdAt,
    chars: content.length,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

function versionName(version: number): string {
  return `v${String(version).padStart(4, "0")}.md`;
}

function cleanTitle(title: string): string {
  const cleaned = title.replace(NUL, "\uFFFD").replace(/\s+/g, " ").trim();
  if (!cleaned) throw new Error("Article title is empty");
  if (cleaned.length > 120) throw new Error("Article title is longer than 120 characters");
  return cleaned;
}

function cleanContent(content: string): string {
  const cleaned = content.replace(NUL, "\uFFFD");
  if (cleaned.trim() === "") throw new Error("Article content is empty");
  if (cleaned.length > MAX_ARTICLE_CHARS) {
    throw new Error(`Article is longer than ${MAX_ARTICLE_CHARS} characters. Split it or cut it down.`);
  }
  return cleaned;
}

function applyEdits(content: string, edits: readonly ArticleEdit[]): string {
  let next = content;
  for (const edit of edits) {
    if (!edit.find) throw new Error("Article edit is missing the text to find");
    const index = next.indexOf(edit.find);
    if (index < 0) throw new Error("Article edit could not find the text to replace. Read the article and quote it exactly.");
    next = `${next.slice(0, index)}${edit.replace}${next.slice(index + edit.find.length)}`;
  }
  return next;
}

function parseRecord(raw: string, id: string): ArticleRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value["id"] !== id || typeof value["title"] !== "string" || typeof value["sessionId"] !== "string") {
    return undefined;
  }
  if (typeof value["createdAt"] !== "string" || typeof value["updatedAt"] !== "string" || !Array.isArray(value["versions"])) {
    return undefined;
  }
  const versions: ArticleVersionInfo[] = [];
  for (const entry of value["versions"]) {
    if (!isRecord(entry) || !Number.isInteger(entry["version"]) || typeof entry["createdAt"] !== "string") return undefined;
    if (!Number.isInteger(entry["chars"]) || typeof entry["sha256"] !== "string") return undefined;
    versions.push({
      version: entry["version"] as number,
      createdAt: entry["createdAt"],
      chars: entry["chars"] as number,
      sha256: entry["sha256"],
    });
  }
  if (versions.length === 0) return undefined;
  return {
    id,
    title: value["title"],
    sessionId: value["sessionId"],
    createdAt: value["createdAt"],
    updatedAt: value["updatedAt"],
    versions,
  };
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
