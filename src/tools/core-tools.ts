import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { ShellService } from "../shell/shell-service.js";
import { atomicWriteFile } from "../storage/atomic.js";

export interface CoreToolOptions {
  workspaceRoot: string;
  shell: ShellService;
  defaultShellTimeoutMs: number;
  maxShellOutputBytes: number;
  maxReadBytes?: number;
  maxSearchOutputBytes?: number;
}

interface EditDetails {
  path: string;
  previousSha256: string;
  sha256: string;
  bytes: number;
}

interface ShellDetails {
  processId: string;
  artifactPath: string;
  artifactSha256: string;
  capturedBytes: number;
}

const readParameters = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    offset: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
  },
  { additionalProperties: false },
);

const editParameters = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    expectedSha256: Type.String({ minLength: 7, maxLength: 64 }),
    content: Type.String({ maxLength: 1_048_576 }),
  },
  { additionalProperties: false },
);

const searchParameters = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 4_096 }),
    path: Type.Optional(Type.String({ minLength: 1 })),
    glob: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  },
  { additionalProperties: false },
);

const shellParameters = Type.Object(
  {
    command: Type.String({ minLength: 1, maxLength: 131_072 }),
    cwd: Type.Optional(Type.String({ minLength: 1 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
  },
  { additionalProperties: false },
);

export function createCoreTools(options: CoreToolOptions): readonly ToolDefinition[] {
  const maxReadBytes = options.maxReadBytes ?? 1_048_576;
  const maxSearchOutputBytes = options.maxSearchOutputBytes ?? 256 * 1024;

  const read = defineTool({
    name: "read",
    label: "Read",
    description: "Read a UTF-8 text file with stable line numbers. Returns a SHA-256 hash for safe edits.",
    promptSnippet: "Read UTF-8 files and obtain hashes for safe edits",
    promptGuidelines: ["Read a file before editing it and pass its SHA-256 hash to edit."],
    parameters: readParameters,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal) => {
      throwIfAborted(signal);
      const path = absolutePath(params.path, options.workspaceRoot);
      const content = await readFile(path);
      if (content.byteLength > maxReadBytes) {
        throw new Error(`File exceeds read limit of ${maxReadBytes} bytes: ${path}`);
      }
      throwIfAborted(signal);
      const text = content.toString("utf8");
      const lines = text.split("\n");
      const offset = params.offset ?? 1;
      const limit = params.limit ?? 400;
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = selected.map((line, index) => `${offset + index}: ${line}`).join("\n");
      const sha256 = hash(content);
      return {
        content: [
          {
            type: "text",
            text: `path: ${path}\nsha256: ${sha256}\nlines: ${lines.length}\n\n${numbered}`,
          },
        ],
        details: { path, sha256, bytes: content.byteLength, offset, returnedLines: selected.length },
      };
    },
  });

  const edit = defineTool<typeof editParameters, EditDetails>({
    name: "edit",
    label: "Edit",
    description:
      'Atomically replace a UTF-8 file after checking expectedSha256. Use expectedSha256="missing" only to create a new file.',
    promptSnippet: "Atomically replace files with an expected hash",
    promptGuidelines: ["Never guess expectedSha256; obtain it from read. Use missing only for new files."],
    parameters: editParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      throwIfAborted(signal);
      const path = absolutePath(params.path, options.workspaceRoot);
      const current = await currentFile(path);
      if (params.expectedSha256 !== current.sha256) {
        throw new Error(
          `Edit conflict for ${path}: expected ${params.expectedSha256}, current ${current.sha256}. Read the file again.`,
        );
      }
      const content = Buffer.from(params.content, "utf8");
      throwIfAborted(signal);
      await atomicWriteFile(path, content, current.mode);
      const sha256 = hash(content);
      return {
        content: [{ type: "text", text: `Updated ${path} (${content.byteLength} bytes, sha256 ${sha256})` }],
        details: { path, previousSha256: current.sha256, sha256, bytes: content.byteLength },
      };
    },
  });

  const search = defineTool({
    name: "search",
    label: "Search",
    description: "Search for exact text with ripgrep and return file, line, and matching content.",
    promptSnippet: "Search exact text in workspace files",
    parameters: searchParameters,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal) => {
      const path = absolutePath(params.path ?? options.workspaceRoot, options.workspaceRoot);
      const result = await runRipgrep(
        {
          query: params.query,
          path,
          ...(params.glob === undefined ? {} : { glob: params.glob }),
          maxResults: params.maxResults ?? 100,
          maxOutputBytes: maxSearchOutputBytes,
        },
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: result.output || (result.matchCount === 0 ? "No exact matches." : "Matches contained no text output."),
          },
        ],
        details: result,
      };
    },
  });

  const shell = defineTool<typeof shellParameters, ShellDetails>({
    name: "shell",
    label: "Shell",
    description: "Run a command in the user's resolved login shell. Full output is stored as a private artifact.",
    promptSnippet: "Run commands in the user's login shell",
    promptGuidelines: ["Use shell only when read, edit, or search cannot perform the task more safely."],
    parameters: shellParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      throwIfAborted(signal);
      const handle = await options.shell.start({
        command: params.command,
        cwd: absolutePath(params.cwd ?? options.workspaceRoot, options.workspaceRoot),
        mode: "pipe",
        timeoutMs: params.timeoutMs ?? options.defaultShellTimeoutMs,
        maxOutputBytes: options.maxShellOutputBytes,
      });
      const abort = () => handle.signal("SIGTERM");
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await handle.completion;
        const summary = {
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          aborted: result.aborted,
          outputLimitExceeded: result.outputLimitExceeded,
          stdout: result.stdout,
          stderr: result.stderr,
          capturedBytes: result.capturedBytes,
          artifactPath: result.artifactPath,
          artifactSha256: result.artifactSha256,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
          details: {
            processId: result.processId,
            artifactPath: result.artifactPath,
            artifactSha256: result.artifactSha256,
            capturedBytes: result.capturedBytes,
          },
        };
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  });

  return [read, edit, search, shell];
}

interface RipgrepOptions {
  query: string;
  path: string;
  glob?: string;
  maxResults: number;
  maxOutputBytes: number;
}

async function runRipgrep(options: RipgrepOptions, signal: AbortSignal | undefined) {
  throwIfAborted(signal);
  const args = ["--fixed-strings", "--line-number", "--no-heading", "--color", "never", "--max-count", String(options.maxResults)];
  if (options.glob) args.push("--glob", options.glob);
  args.push("--", options.query, options.path);
  const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;
  const capture = (chunk: Buffer | string) => {
    const buffer = Buffer.from(chunk);
    const remaining = options.maxOutputBytes - capturedBytes;
    if (remaining <= 0) {
      truncated = true;
      child.kill("SIGTERM");
      return;
    }
    const accepted = buffer.subarray(0, remaining);
    chunks.push(accepted);
    capturedBytes += accepted.byteLength;
    if (accepted.byteLength < buffer.byteLength) {
      truncated = true;
      child.kill("SIGTERM");
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const abort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const { code, error } = await new Promise<{ code: number | null; error?: Error }>((resolveResult) => {
      let spawnError: Error | undefined;
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (code) => resolveResult({ code, ...(spawnError ? { error: spawnError } : {}) }));
    });
    if (error) throw error;
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Search aborted");
    if (code !== 0 && code !== 1 && !truncated) throw new Error(`ripgrep exited with code ${String(code)}`);
    const output = Buffer.concat(chunks).toString("utf8").trimEnd();
    return {
      output: `${output}${truncated ? "\n[pSpore: search output truncated]" : ""}`.trimStart(),
      matchCount: output ? output.split("\n").length : 0,
      capturedBytes,
      truncated,
    };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function currentFile(path: string): Promise<{ sha256: string; mode: number }> {
  try {
    const content = await readFile(path);
    return { sha256: hash(content), mode: (await stat(path)).mode & 0o777 };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      await realpath(resolve(path, ".."));
      return { sha256: "missing", mode: 0o600 };
    }
    throw error;
  }
}

function absolutePath(path: string, cwd: string): string {
  return resolve(isAbsolute(path) ? path : resolve(cwd, path));
}

function hash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
