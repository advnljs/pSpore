import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { atomicWriteJson } from "../storage/atomic.js";
import { rankBm25 } from "./bm25.js";
import { estimateTokens, tokenize } from "./tokenizer.js";

export type SearchScope = "memory" | "sessions" | "workspace" | "project";
export type SearchMode = "auto" | "exact" | "bm25";

export interface SearchQuery {
  query: string;
  scopes?: readonly SearchScope[];
  mode?: SearchMode;
  pathPrefix?: string;
  glob?: string;
  maxResults: number;
  maxReturnedTokens: number;
}

export interface SearchHit {
  ref: string;
  scope: SearchScope;
  path: string;
  line: number;
  heading?: string;
  score: number;
  mtimeMs: number;
  snippet: string;
  contentSha256: string;
}

export interface SearchServiceOptions {
  workspaceRoot: string;
  sessionsRoot: string;
  cachePath: string;
  projectRoot?: string;
  maxFileBytes?: number;
  chunkTargetTokens?: number;
  chunkOverlapTokens?: number;
}

interface IndexedChunk {
  id: string;
  scope: SearchScope;
  path: string;
  line: number;
  heading?: string;
  text: string;
  contentSha256: string;
  mtimeMs: number;
}

interface IndexedFile {
  path: string;
  scope: SearchScope;
  size: number;
  mtimeMs: number;
  contentSha256: string;
  chunks: IndexedChunk[];
}

interface SearchCache {
  version: 1;
  files: Record<string, IndexedFile>;
}

interface Candidate {
  path: string;
  scope: SearchScope;
}

const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "cache",
  ".cache",
  "credentials",
  ".ssh",
  ".gnupg",
  "trash",
]);
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".jsonl",
  ".json",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".sh",
  ".bash",
  ".zsh",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".sql",
  ".css",
  ".html",
  ".xml",
]);
const SENSITIVE_FILE = /(^\.env(?:\.|$)|credentials?|secrets?|id_(?:rsa|ed25519)|\.(?:pem|key|p12|pfx|crt|cer)$)/i;

export class SearchService {
  readonly #options: SearchServiceOptions;
  #cache: SearchCache | undefined;
  #indexing: Promise<void> | undefined;

  constructor(options: SearchServiceOptions) {
    this.#options = options;
  }

  async search(query: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]> {
    validateQuery(query);
    throwIfAborted(signal);
    await this.ensureIndexed(signal);
    const cache = this.#cache ?? { version: 1, files: {} };
    const scopes = new Set(query.scopes ?? ["memory", "sessions", "workspace", "project"]);
    const prefix = query.pathPrefix ? await canonicalPrefix(query.pathPrefix, this.#options.workspaceRoot) : undefined;
    const chunks = Object.values(cache.files)
      .flatMap((file) => file.chunks)
      .filter(
        (chunk) =>
          scopes.has(chunk.scope) &&
          (!prefix || isWithin(prefix, chunk.path)) &&
          (!query.glob || matchesGlob(chunk.path, query.glob)),
      );
    const bm25 = new Map(
      rankBm25(
        query.query,
        chunks.map((chunk) => ({ id: chunk.id, text: `${chunk.heading ?? ""}\n${chunk.text}` })),
      ).map((score) => [score.id, score.score]),
    );
    const normalizedQuery = query.query.normalize("NFKC").toLocaleLowerCase("und");
    const queryTokens = [...new Set(tokenize(query.query))];
    const ranked = chunks
      .map((chunk) => {
        const searchable = `${chunk.heading ?? ""}\n${chunk.text}`.normalize("NFKC").toLocaleLowerCase("und");
        const exact = searchable.includes(normalizedQuery);
        const lexicalOverlap = queryTokens.filter((token) => searchable.includes(token)).length;
        const lexicalScore = bm25.get(chunk.id) ?? 0;
        const score = lexicalScore + (exact ? 8 : 0) + lexicalOverlap * 0.05;
        return { chunk, exact, score };
      })
      .filter((item) => {
        const mode = query.mode ?? "auto";
        if (mode === "exact") return item.exact;
        if (mode === "bm25") return (bm25.get(item.chunk.id) ?? 0) > 0;
        return item.score > 0;
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.chunk.path.localeCompare(right.chunk.path) ||
          left.chunk.line - right.chunk.line,
      );

    const hits: SearchHit[] = [];
    let returnedTokens = 0;
    for (const item of ranked) {
      if (hits.length >= query.maxResults) break;
      throwIfAborted(signal);
      let snippet = makeSnippet(item.chunk.text, query.query, 900);
      let tokens = estimateTokens(snippet);
      const remainingTokens = query.maxReturnedTokens - returnedTokens;
      if (remainingTokens <= 0) break;
      if (tokens > remainingTokens) {
        snippet = limitTextByTokens(snippet, remainingTokens);
        tokens = estimateTokens(snippet);
      }
      returnedTokens += tokens;
      hits.push({
        ref: `source:${item.chunk.contentSha256.slice(0, 16)}:${item.chunk.line}`,
        scope: item.chunk.scope,
        path: item.chunk.path,
        line: item.chunk.line,
        ...(item.chunk.heading === undefined ? {} : { heading: item.chunk.heading }),
        score: Number(item.score.toFixed(6)),
        mtimeMs: item.chunk.mtimeMs,
        snippet,
        contentSha256: item.chunk.contentSha256,
      });
    }
    return hits;
  }

  ensureIndexed(signal?: AbortSignal): Promise<void> {
    this.#indexing ??= this.#refresh(signal).finally(() => {
      this.#indexing = undefined;
    });
    return this.#indexing;
  }

  async #refresh(signal: AbortSignal | undefined): Promise<void> {
    const previous = this.#cache ?? (await loadCache(this.#options.cachePath));
    const candidates = await discoverCandidates(this.#options, signal);
    const files: Record<string, IndexedFile> = {};
    let changed = Object.keys(previous.files).length !== candidates.length;
    for (const candidate of candidates) {
      throwIfAborted(signal);
      const metadata = await stat(candidate.path);
      const maxFileBytes = this.#options.maxFileBytes ?? 2 * 1024 * 1024;
      if (!metadata.isFile() || metadata.size > maxFileBytes) continue;
      const content = await readFile(candidate.path);
      if (content.includes(0)) continue;
      const contentSha256 = createHash("sha256").update(content).digest("hex");
      const cached = previous.files[candidate.path];
      if (
        cached &&
        cached.scope === candidate.scope &&
        cached.size === metadata.size &&
        cached.mtimeMs === metadata.mtimeMs &&
        cached.contentSha256 === contentSha256
      ) {
        files[candidate.path] = cached;
        continue;
      }
      changed = true;
      const text = content.toString("utf8");
      const chunks = chunkDocument(candidate, text, contentSha256, metadata.mtimeMs, {
        targetTokens: this.#options.chunkTargetTokens ?? 600,
        overlapTokens: this.#options.chunkOverlapTokens ?? 80,
      });
      files[candidate.path] = {
        path: candidate.path,
        scope: candidate.scope,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        contentSha256,
        chunks,
      };
    }
    const next: SearchCache = { version: 1, files };
    this.#cache = next;
    if (changed || !(await cacheExists(this.#options.cachePath))) await atomicWriteJson(this.#options.cachePath, next, 0o600);
  }
}

async function discoverCandidates(options: SearchServiceOptions, signal: AbortSignal | undefined): Promise<Candidate[]> {
  const workspace = await realpath(options.workspaceRoot);
  const sessions = await realpath(options.sessionsRoot);
  const roots: Array<{ root: string; defaultScope: SearchScope }> = [
    { root: workspace, defaultScope: "workspace" },
    { root: sessions, defaultScope: "sessions" },
  ];
  if (options.projectRoot) {
    const project = await realpath(options.projectRoot);
    if (project !== workspace && project !== sessions) roots.push({ root: project, defaultScope: "project" });
  }
  const found = new Map<string, Candidate>();
  for (const source of roots) await walk(source.root, source.root, source.defaultScope, found, signal);
  return [...found.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(
  root: string,
  directory: string,
  defaultScope: SearchScope,
  found: Map<string, Candidate>,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    throwIfAborted(signal);
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) await walk(root, path, defaultScope, found, signal);
      continue;
    }
    if (!entry.isFile() || !isTextCandidate(entry.name)) continue;
    const canonical = await realpath(path);
    if (!isWithin(root, canonical)) continue;
    const relativePath = relative(root, canonical).split(sep).join("/");
    const scope =
      defaultScope === "workspace" && (relativePath === "MEMORY.md" || relativePath.startsWith("memory/"))
        ? "memory"
        : defaultScope;
    const existing = found.get(canonical);
    if (!existing || scopePriority(scope) < scopePriority(existing.scope)) found.set(canonical, { path: canonical, scope });
  }
}

function chunkDocument(
  candidate: Candidate,
  text: string,
  contentSha256: string,
  mtimeMs: number,
  budget: { targetTokens: number; overlapTokens: number },
): IndexedChunk[] {
  const extension = extname(candidate.path).toLowerCase();
  const units = extension === ".jsonl" ? jsonlUnits(text) : textUnits(text, extension === ".md");
  const chunks: IndexedChunk[] = [];
  let current: DocumentUnit[] = [];
  let currentTokens = 0;
  const flush = () => {
    if (current.length === 0) return;
    const content = current.map((unit) => unit.text).join("\n\n");
    const first = current[0];
    if (!first) return;
    const index = chunks.length;
    chunks.push({
      id: createHash("sha256").update(`${candidate.path}\0${contentSha256}\0${index}`).digest("hex"),
      scope: candidate.scope,
      path: candidate.path,
      line: first.line,
      ...(first.heading ? { heading: first.heading } : {}),
      text: content,
      contentSha256,
      mtimeMs,
    });
  };
  for (const unit of units) {
    const unitTokens = estimateTokens(unit.text);
    if (current.length > 0 && currentTokens + unitTokens > budget.targetTokens) {
      flush();
      const overlap: DocumentUnit[] = [];
      let overlapTokens = 0;
      for (const prior of [...current].reverse()) {
        const priorTokens = estimateTokens(prior.text);
        if (overlap.length > 0 && overlapTokens + priorTokens > budget.overlapTokens) break;
        overlap.unshift(prior);
        overlapTokens += priorTokens;
      }
      current = overlap;
      currentTokens = overlapTokens;
    }
    current.push(unit);
    currentTokens += unitTokens;
  }
  flush();
  return chunks;
}

interface DocumentUnit {
  line: number;
  heading?: string;
  text: string;
}

function textUnits(text: string, markdown: boolean): DocumentUnit[] {
  const lines = text.split("\n");
  const units: DocumentUnit[] = [];
  let heading: string | undefined;
  let paragraph: string[] = [];
  let paragraphLine = 1;
  const flush = () => {
    const content = paragraph.join("\n").trim();
    if (content) units.push({ line: paragraphLine, ...(heading ? { heading } : {}), text: content });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const match = markdown ? /^(#{1,6})\s+(.+)$/.exec(line) : undefined;
    if (match) {
      flush();
      heading = match[2]?.trim();
      paragraphLine = index + 2;
      continue;
    }
    if (!line.trim()) {
      flush();
      paragraphLine = index + 2;
    } else {
      if (paragraph.length === 0) paragraphLine = index + 1;
      paragraph.push(line);
    }
  }
  flush();
  return units;
}

function jsonlUnits(text: string): DocumentUnit[] {
  const lines = text.split("\n");
  const lastContentIndex = lines.findLastIndex((line) => Boolean(line?.trim()));
  const units: DocumentUnit[] = [];
  for (let index = 0; index <= lastContentIndex; index++) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (index === lastContentIndex) break;
      throw new Error(`Malformed JSONL at line ${index + 1}`);
    }
    const rendered = renderJsonlEntry(value);
    if (rendered) units.push({ line: index + 1, heading: rendered.heading, text: rendered.text });
  }
  return units;
}

function renderJsonlEntry(value: unknown): { heading: string; text: string } | undefined {
  if (!isRecord(value)) return undefined;
  const type = typeof value["type"] === "string" ? value["type"] : "entry";
  const message = isRecord(value["message"]) ? value["message"] : value;
  const role = typeof message["role"] === "string" ? message["role"] : type;
  const text = extractText(message["content"] ?? message["text"] ?? value["summary"]);
  return text ? { heading: `${type}:${role}`, text } : undefined;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => (isRecord(item) && typeof item["text"] === "string" ? item["text"] : ""))
    .filter(Boolean)
    .join("\n");
}

function makeSnippet(text: string, query: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  const normalizedText = text.normalize("NFKC").toLocaleLowerCase("und");
  const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase("und");
  const match = normalizedText.indexOf(normalizedQuery);
  const center = match >= 0 ? match : 0;
  const start = Math.max(0, center - Math.floor(maxCharacters / 3));
  const end = Math.min(text.length, start + maxCharacters);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

async function loadCache(path: string): Promise<SearchCache> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isSearchCache(value)) return { version: 1, files: {} };
    return value as unknown as SearchCache;
  } catch {
    return { version: 1, files: {} };
  }
}

async function cacheExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isTextCandidate(name: string): boolean {
  if (SENSITIVE_FILE.test(name)) return false;
  return TEXT_EXTENSIONS.has(extname(name).toLowerCase());
}

function scopePriority(scope: SearchScope): number {
  return { memory: 0, sessions: 1, workspace: 2, project: 3 }[scope];
}

function validateQuery(query: SearchQuery): void {
  if (!query.query.trim() || query.query.length > 4_096) throw new Error("Search query must contain 1 to 4096 characters");
  if (!Number.isSafeInteger(query.maxResults) || query.maxResults < 1 || query.maxResults > 500) {
    throw new Error("Search maxResults must be between 1 and 500");
  }
  if (!Number.isSafeInteger(query.maxReturnedTokens) || query.maxReturnedTokens < 1) {
    throw new Error("Search maxReturnedTokens must be a positive safe integer");
  }
}

function matchesGlob(path: string, glob: string): boolean {
  const normalizedPath = path.split(sep).join("/");
  const escaped = glob
    .split("")
    .map((character, index, all) => {
      if (character === "*" && all[index + 1] === "*") return "__DOUBLE_STAR__";
      if (character === "*" && all[index - 1] === "*") return "";
      if (character === "*") return "[^/]*";
      if (character === "?") return "[^/]";
      return character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("")
    .replaceAll("__DOUBLE_STAR__", ".*");
  const expression = new RegExp(`(?:^|/)${escaped}$`);
  return expression.test(normalizedPath);
}

function limitTextByTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  let result = `${text.slice(0, low).trimEnd()}…`;
  while (result.length > 1 && estimateTokens(result) > maxTokens) result = `${result.slice(0, -2).trimEnd()}…`;
  return result;
}

async function canonicalPrefix(path: string, workspace: string): Promise<string> {
  return realpath(isAbsolute(path) ? path : resolve(workspace, path));
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Search aborted");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSearchCache(value: unknown): value is SearchCache {
  if (!isRecord(value) || value["version"] !== 1 || !isRecord(value["files"])) return false;
  return Object.entries(value["files"]).every(([path, file]) => {
    if (!isRecord(file) || file["path"] !== path || !Array.isArray(file["chunks"])) return false;
    return (
      typeof file["scope"] === "string" &&
      typeof file["size"] === "number" &&
      typeof file["mtimeMs"] === "number" &&
      typeof file["contentSha256"] === "string" &&
      file["chunks"].every(
        (chunk) =>
          isRecord(chunk) &&
          typeof chunk["id"] === "string" &&
          typeof chunk["path"] === "string" &&
          typeof chunk["scope"] === "string" &&
          typeof chunk["line"] === "number" &&
          typeof chunk["text"] === "string" &&
          typeof chunk["contentSha256"] === "string" &&
          typeof chunk["mtimeMs"] === "number",
      )
    );
  });
}
