import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type { PinnedContextFile } from "../domain/runtime.js";
import { estimateTokens } from "./tokenizer.js";

export interface PinnedFileDiagnostic {
  path: string;
  status: "loaded" | "missing";
  estimatedTokens: number;
  sha256?: string;
}

export interface PinnedContextSnapshot {
  files: readonly PinnedContextFile[];
  diagnostics: readonly PinnedFileDiagnostic[];
  estimatedTokens: number;
  prefixSha256: string;
}

export interface PinnedContextLoaderOptions {
  workspaceRoot: string;
  pinnedFiles: readonly string[];
  maxPinnedTokens: number;
  maxFileBytes?: number;
}

const FIRST = ["AGENTS.md", "SOUL.md", "USER.md"];
const LAST = "MEMORY.md";
const SENSITIVE_NAMES = /(^|\/)(\.env(?:\.|$)|credentials?|secrets?|\.ssh|\.gnupg)(\/|$)|\.(?:pem|key|p12|pfx)$/i;

export class PinnedContextLoader {
  readonly #options: PinnedContextLoaderOptions;
  readonly #cache = new Map<string, { size: number; mtimeMs: number; content: string; sha256: string }>();

  constructor(options: PinnedContextLoaderOptions) {
    this.#options = options;
  }

  async load(): Promise<PinnedContextSnapshot> {
    const workspace = await realpath(this.#options.workspaceRoot);
    const ordered = orderPinnedFiles(this.#options.pinnedFiles);
    const files: PinnedContextFile[] = [];
    const diagnostics: PinnedFileDiagnostic[] = [];
    const seen = new Set<string>();
    let estimatedTokens = 0;
    for (const configured of ordered) {
      validateConfiguredPath(configured);
      const candidate = join(workspace, configured);
      let canonical: string;
      try {
        canonical = await realpath(candidate);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          diagnostics.push({ path: candidate, status: "missing", estimatedTokens: 0 });
          continue;
        }
        throw error;
      }
      if (!isWithin(workspace, canonical)) throw new Error(`Pinned context escapes workspace: ${configured}`);
      const workspaceRelative = relative(workspace, canonical).split(sep).join("/");
      if (SENSITIVE_NAMES.test(workspaceRelative)) throw new Error(`Sensitive path cannot be pinned: ${configured}`);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const metadata = await stat(canonical);
      if (!metadata.isFile()) throw new Error(`Pinned context is not a regular file: ${configured}`);
      const maxFileBytes = this.#options.maxFileBytes ?? 512 * 1024;
      if (metadata.size > maxFileBytes) throw new Error(`Pinned context exceeds ${maxFileBytes} bytes: ${configured}`);
      const cached = this.#cache.get(canonical);
      const diskContent = await readFile(canonical, "utf8");
      const diskSha256 = createHash("sha256").update(diskContent).digest("hex");
      let content = diskContent;
      let sha256 = diskSha256;
      if (cached && cached.sha256 === diskSha256) {
        content = cached.content;
        sha256 = cached.sha256;
      } else {
        this.#cache.set(canonical, { size: metadata.size, mtimeMs: metadata.mtimeMs, content, sha256 });
      }
      const fileTokens = estimateTokens(content);
      estimatedTokens += fileTokens;
      diagnostics.push({ path: canonical, status: "loaded", estimatedTokens: fileTokens, sha256 });
      files.push({ path: canonical, content });
    }
    if (estimatedTokens > this.#options.maxPinnedTokens) {
      const breakdown = diagnostics
        .filter((item) => item.status === "loaded")
        .map((item) => `${item.path}=${item.estimatedTokens}`)
        .join(", ");
      throw new Error(
        `Pinned context estimate ${estimatedTokens} exceeds maxPinnedTokens ${this.#options.maxPinnedTokens}; ${breakdown}`,
      );
    }
    const prefixSha256 = createHash("sha256")
      .update(files.map((file) => `${file.path}\0${file.content}`).join("\0"))
      .digest("hex");
    return { files, diagnostics, estimatedTokens, prefixSha256 };
  }
}

export function orderPinnedFiles(files: readonly string[]): string[] {
  const unique = [...new Set(files)];
  const first = FIRST.filter((name) => unique.includes(name));
  const middle = unique.filter((name) => !FIRST.includes(name) && name !== LAST).sort((left, right) => left.localeCompare(right));
  return [...first, ...middle, ...(unique.includes(LAST) ? [LAST] : [])];
}

function validateConfiguredPath(path: string): void {
  if (!path.trim() || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`Pinned context path must be workspace-relative without traversal: ${path}`);
  }
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
