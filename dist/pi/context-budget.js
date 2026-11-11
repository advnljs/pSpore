import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../storage/atomic.js";
/** A single read/MCP result must not consume most of a 100k context. */
export const MAX_TOOL_RESULT_CHARS = 24_000;
/** Pi's compaction serializes only the first 2000 characters of a tool result. */
const SUMMARY_TAIL_PREVIEW_CHARS = 512;
/** Keep complete results locally; only the bounded excerpt enters model history. */
export async function boundToolResult(content, artifactDirectory) {
    const text = content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    if (text.length <= MAX_TOOL_RESULT_CHARS)
        return content;
    const path = join(artifactDirectory, `${randomUUID()}.txt`);
    let location;
    try {
        await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
        await atomicWriteFile(path, text, 0o600);
        location = `Full output: ${path}. Read selected lines with read offset/limit, or use shell to search/slice long lines; avoid loading the whole file.`;
    }
    catch (error) {
        if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string")
            throw error;
        // The tool may have already changed files or sent a request. An artifact
        // storage failure must not misreport its successful execution as a failure
        // and encourage the model to repeat those side effects.
        location = `Full output could not be saved (${error.code}). The tool already completed; do not repeat actions just to recreate this output.`;
    }
    // Keep the retrieval reference and a brief tail *before* the large excerpt.
    // Otherwise Pi's own summary truncation would drop both and make a completed
    // action's evidence unavailable to the next turn after compaction.
    const prefix = `[pSpore: tool output excerpt; ${text.length} characters total. ${location}]\n\n[End of output preview]\n${safeSlice(text, Math.max(0, text.length - SUMMARY_TAIL_PREVIEW_CHARS), text.length)}\n\n[Beginning of output]\n`;
    const marker = "\n\n[... middle omitted ...]\n\n";
    const budget = Math.max(0, MAX_TOOL_RESULT_CHARS - prefix.length - marker.length);
    const head = Math.floor(budget * 2 / 3);
    const tail = text.length - (budget - head);
    const excerpt = `${prefix}${safeSlice(text, 0, head)}${marker}${safeSlice(text, tail, text.length)}`;
    // Keep images and their order; replace text blocks with one bounded excerpt.
    let replaced = false;
    return content.flatMap((block) => {
        if (block.type !== "text")
            return [block];
        if (replaced)
            return [];
        replaced = true;
        return [{ type: "text", text: excerpt }];
    });
}
function safeSlice(text, start, end) {
    return text.slice(splitsSurrogatePair(text, start) ? start + 1 : start, splitsSurrogatePair(text, end) ? end - 1 : end);
}
function splitsSurrogatePair(text, index) {
    return /[\uD800-\uDBFF]/.test(text.charAt(index - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(index));
}
/** Fallback only: count non-ASCII text conservatively when no fresh usage exists. */
export function estimateTextTokens(text) {
    let units = 0;
    for (const character of text)
        units += character.codePointAt(0) <= 0x7f ? 1 : 4;
    return Math.ceil(units / 4);
}
//# sourceMappingURL=context-budget.js.map