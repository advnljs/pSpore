import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_MAX_DOCUMENT_BYTES, extractDocument, UnsupportedDocumentError, } from "../documents/extract.js";
import { ShellService } from "../shell/shell-service.js";
import { atomicWriteFile } from "../storage/atomic.js";
const readParameters = Type.Object({
    path: Type.String({ minLength: 1 }),
    offset: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
    expectedSha256: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })),
}, { additionalProperties: false });
const editParameters = Type.Object({
    path: Type.String({ minLength: 1 }),
    expectedSha256: Type.String({ minLength: 7, maxLength: 64 }),
    content: Type.String({ maxLength: 1_048_576 }),
}, { additionalProperties: false });
const searchParameters = Type.Object({
    query: Type.String({ minLength: 1, maxLength: 4_096 }),
    path: Type.Optional(Type.String({ minLength: 1 })),
    glob: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("exact"), Type.Literal("bm25")])),
    scopes: Type.Optional(Type.Array(Type.Union([
        Type.Literal("memory"),
        Type.Literal("sessions"),
        Type.Literal("workspace"),
        Type.Literal("project"),
    ]), { minItems: 1, maxItems: 4 })),
}, { additionalProperties: false });
/**
 * Character offsets rather than lines: an extracted document has no stable line
 * numbering to page by, and a spreadsheet or slide deck has no lines at all.
 */
/**
 * Text returned by one `document` call when the caller does not say otherwise.
 * Large enough to summarize most single documents in one turn, small enough not
 * to spend the whole context window on a file nobody has read yet.
 */
const DEFAULT_DOCUMENT_CHUNK = 30_000;
const documentParameters = Type.Object({
    path: Type.String({ minLength: 1 }),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200_000 })),
}, { additionalProperties: false });
const shellParameters = Type.Object({
    command: Type.String({ minLength: 1, maxLength: 131_072 }),
    cwd: Type.Optional(Type.String({ minLength: 1 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
}, { additionalProperties: false });
export function createCoreTools(options) {
    const maxReadBytes = options.maxReadBytes ?? 1_048_576;
    const maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
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
            // A NUL means these bytes were never the UTF-8 text this tool documents.
            // Decoding a container format — a .docx is a ZIP — yields pages of mojibake
            // that tell the model nothing and cost it context, so hand the caller to
            // the tool that can actually read it.
            if (text.includes("\u0000")) {
                throw new Error(`Not a UTF-8 text file: ${path}. Use the document tool, which reads Word, Excel, PowerPoint and PDF.`);
            }
            const lines = text.split("\n");
            const offset = params.offset ?? 1;
            const limit = params.limit ?? 400;
            const selected = lines.slice(offset - 1, offset - 1 + limit);
            const numbered = selected.map((line, index) => `${offset + index}: ${line}`).join("\n");
            const sha256 = hash(content);
            if (params.expectedSha256 !== undefined && params.expectedSha256 !== sha256) {
                throw new Error(`Read conflict for ${path}: expected ${params.expectedSha256}, current ${sha256}`);
            }
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
    /**
     * The counterpart to `read` for everything that is not already text. `read`
     * refuses a binary file on purpose, and without this the only way to answer a
     * question about the user's own Word, Excel, PowerPoint or PDF documents would
     * be to guess at their contents.
     */
    const document = defineTool({
        name: "document",
        label: "Document",
        description: "Extract plain text from a document: Word (.docx/.doc), Excel (.xlsx/.xls), PowerPoint (.pptx/.ppt), "
            + "PDF, or a text file in any common encoding. The format is detected from the file's own bytes, so "
            + "an unusual or missing extension is fine. Use this instead of read for anything that is not plain text.",
        promptSnippet: "Extract text from Word, Excel, PowerPoint, PDF and other documents",
        promptGuidelines: [
            "Use document, not read, for .docx/.doc/.xlsx/.xls/.pptx/.ppt/.pdf and for any file read refuses as binary.",
            "A long document comes back in one bounded chunk; pass offset to continue from where the last one stopped.",
        ],
        parameters: documentParameters,
        executionMode: "parallel",
        execute: async (_toolCallId, params, signal) => {
            throwIfAborted(signal);
            const path = absolutePath(params.path, options.workspaceRoot);
            const offset = params.offset ?? 0;
            const limit = params.limit ?? DEFAULT_DOCUMENT_CHUNK;
            let extracted;
            try {
                // The whole document is extracted and then sliced: none of these formats
                // can be decoded from the middle, and the total length is what tells the
                // caller whether there is more to ask for.
                extracted = await extractDocument(path, { maxBytes: maxDocumentBytes, limit: Number.MAX_SAFE_INTEGER });
            }
            catch (error) {
                // An unreadable format is a fact about the file, not a failure to report
                // as an internal error, so it is passed through as written.
                if (error instanceof UnsupportedDocumentError)
                    throw new Error(error.message);
                throw error;
            }
            throwIfAborted(signal);
            const total = extracted.text.length;
            const chunk = extracted.text.slice(offset, offset + limit);
            const header = [
                `path: ${path}`,
                `format: ${extracted.format} (${extracted.formatLabel})`,
                ...(extracted.encoding === undefined ? [] : [`encoding: ${extracted.encoding}`]),
                ...(extracted.sections.length > 0 ? [`sections: ${extracted.sections.length}`] : []),
                `characters: ${offset + 1}-${offset + chunk.length} of ${total}`,
                ...(offset + chunk.length < total
                    ? [`more: pass offset=${offset + chunk.length} to continue`]
                    : []),
            ].join("\n");
            return {
                content: [{ type: "text", text: `${header}\n\n${chunk}` }],
                details: {
                    path,
                    format: extracted.format,
                    bytes: extracted.bytes,
                    characters: chunk.length,
                    totalCharacters: total,
                    offset,
                    ...(extracted.sections.length > 0 ? { sections: extracted.sections.map((section) => section.name) } : {}),
                    ...(extracted.encoding === undefined ? {} : { encoding: extracted.encoding }),
                },
            };
        },
    });
    const edit = defineTool({
        name: "edit",
        label: "Edit",
        description: 'Atomically replace a UTF-8 file after checking expectedSha256. Use expectedSha256="missing" only to create a new file.',
        promptSnippet: "Atomically replace files with an expected hash",
        promptGuidelines: ["Never guess expectedSha256; obtain it from read. Use missing only for new files."],
        parameters: editParameters,
        executionMode: "sequential",
        execute: async (_toolCallId, params, signal) => {
            throwIfAborted(signal);
            const path = absolutePath(params.path, options.workspaceRoot);
            const current = await currentFile(path);
            if (params.expectedSha256 !== current.sha256) {
                throw new Error(`Edit conflict for ${path}: expected ${params.expectedSha256}, current ${current.sha256}. Read the file again.`);
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
            if (options.retrieval) {
                const hits = await options.retrieval.search({
                    query: params.query,
                    ...(params.scopes === undefined ? {} : { scopes: params.scopes }),
                    ...(params.mode === undefined ? {} : { mode: params.mode }),
                    ...(params.path === undefined ? {} : { pathPrefix: params.path }),
                    ...(params.glob === undefined ? {} : { glob: params.glob }),
                    maxResults: params.maxResults ?? options.defaultSearchMaxResults ?? 8,
                    maxReturnedTokens: options.defaultSearchMaxReturnedTokens ?? 3_000,
                }, signal);
                return {
                    content: [{ type: "text", text: hits.length > 0 ? JSON.stringify(hits, null, 2) : "No matches." }],
                    details: { hits },
                };
            }
            const path = absolutePath(params.path ?? options.workspaceRoot, options.workspaceRoot);
            const result = await runRipgrep({
                query: params.query,
                path,
                ...(params.glob === undefined ? {} : { glob: params.glob }),
                maxResults: params.maxResults ?? 100,
                maxOutputBytes: maxSearchOutputBytes,
            }, signal);
            return {
                content: [
                    {
                        type: "text",
                        text: result.output || (result.matchCount === 0 ? "No exact matches." : "Matches contained no text output."),
                    },
                ],
                details: {
                    fallback: {
                        matchCount: result.matchCount,
                        capturedBytes: result.capturedBytes,
                        truncated: result.truncated,
                    },
                },
            };
        },
    });
    const shell = defineTool({
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
            }
            finally {
                signal?.removeEventListener("abort", abort);
            }
        },
    });
    return [read, document, edit, search, shell];
}
async function runRipgrep(options, signal) {
    throwIfAborted(signal);
    const args = ["--fixed-strings", "--line-number", "--no-heading", "--color", "never", "--max-count", String(options.maxResults)];
    if (options.glob)
        args.push("--glob", options.glob);
    args.push("--", options.query, options.path);
    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let capturedBytes = 0;
    let truncated = false;
    const capture = (chunk) => {
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
        const { code, error } = await new Promise((resolveResult) => {
            let spawnError;
            child.once("error", (error) => {
                spawnError = error;
            });
            child.once("close", (code) => resolveResult({ code, ...(spawnError ? { error: spawnError } : {}) }));
        });
        if (error)
            throw error;
        if (signal?.aborted)
            throw signal.reason instanceof Error ? signal.reason : new Error("Search aborted");
        if (code !== 0 && code !== 1 && !truncated)
            throw new Error(`ripgrep exited with code ${String(code)}`);
        const output = Buffer.concat(chunks).toString("utf8").trimEnd();
        return {
            output: `${output}${truncated ? "\n[pSpore: search output truncated]" : ""}`.trimStart(),
            matchCount: output ? output.split("\n").length : 0,
            capturedBytes,
            truncated,
        };
    }
    finally {
        signal?.removeEventListener("abort", abort);
    }
}
async function currentFile(path) {
    try {
        const content = await readFile(path);
        return { sha256: hash(content), mode: (await stat(path)).mode & 0o777 };
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            await realpath(resolve(path, ".."));
            return { sha256: "missing", mode: 0o600 };
        }
        throw error;
    }
}
function absolutePath(path, cwd) {
    return resolve(isAbsolute(path) ? path : resolve(cwd, path));
}
function hash(content) {
    return createHash("sha256").update(content).digest("hex");
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
//# sourceMappingURL=core-tools.js.map