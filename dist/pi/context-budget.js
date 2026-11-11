import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../storage/atomic.js";
/** A single read/MCP result must not consume most of a 100k context. */
export const MAX_TOOL_RESULT_CHARS = 24_000;
/** Keep complete results locally; only the bounded excerpt enters model history. */
export async function boundToolResult(content, artifactDirectory) {
    const text = content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    if (text.length <= MAX_TOOL_RESULT_CHARS)
        return content;
    await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
    const path = join(artifactDirectory, `${randomUUID()}.txt`);
    await atomicWriteFile(path, text, 0o600);
    const marker = `\n\n[pSpore: tool output excerpt; ${text.length} characters total. Full output: ${path}. Read selected lines with read offset/limit, or use shell to search/slice long lines; avoid loading the whole file.]\n\n`;
    const budget = Math.max(0, MAX_TOOL_RESULT_CHARS - marker.length);
    const head = Math.floor(budget * 2 / 3);
    const excerpt = `${text.slice(0, head)}${marker}${text.slice(text.length - (budget - head))}`;
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
/** Fallback only: count non-ASCII text conservatively when no fresh usage exists. */
export function estimateTextTokens(text) {
    let units = 0;
    for (const character of text)
        units += character.codePointAt(0) <= 0x7f ? 1 : 4;
    return Math.ceil(units / 4);
}
//# sourceMappingURL=context-budget.js.map