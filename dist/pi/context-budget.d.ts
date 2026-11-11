import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
/** A single read/MCP result must not consume most of a 100k context. */
export declare const MAX_TOOL_RESULT_CHARS = 24000;
/** Keep complete results locally; only the bounded excerpt enters model history. */
export declare function boundToolResult(content: (TextContent | ImageContent)[], artifactDirectory: string): Promise<(TextContent | ImageContent)[]>;
/** Fallback only: count non-ASCII text conservatively when no fresh usage exists. */
export declare function estimateTextTokens(text: string): number;
//# sourceMappingURL=context-budget.d.ts.map