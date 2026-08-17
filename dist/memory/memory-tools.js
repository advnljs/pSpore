import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MemoryService } from "./memory-service.js";
const appendParameters = Type.Object({
    fact: Type.String({
        minLength: 1,
        maxLength: 2_000,
        description: "One concise durable fact. Never include credentials or raw tool output.",
    }),
    runId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Current run ID, only when one exists." })),
}, { additionalProperties: false });
const curateParameters = Type.Object({
    expectedSha256: Type.String({
        minLength: 64,
        maxLength: 64,
        description: "Exact SHA-256 returned by reading MEMORY.md immediately before this call.",
    }),
    entries: Type.Array(Type.Object({
        fact: Type.String({ minLength: 1, maxLength: 2_000 }),
        sources: Type.Array(Type.String({
            minLength: 1,
            maxLength: 255,
            pattern: "^(?:session|run|file):[A-Za-z0-9._/:@-]{1,240}$",
            description: "Source reference in exactly one of these forms: session:main, run:RUN_ID, or file:path/from/workspace.md.",
        }), { minItems: 1, maxItems: 20 }),
    }, { additionalProperties: false }), { minItems: 1, maxItems: 50 }),
}, { additionalProperties: false });
export function createMemoryTools(sessionId, memory) {
    const append = defineTool({
        name: "memory_append",
        label: "Append Memory",
        description: "Append one brief sourced fact to today's durable memory log. Never store credentials or raw tool output.",
        promptSnippet: "Save a concise fact to today's durable memory log",
        promptGuidelines: ["Use memory_append for a new fact first; use runId only when a real run ID is available."],
        parameters: appendParameters,
        executionMode: "sequential",
        execute: async (_toolCallId, params, signal) => {
            throwIfAborted(signal);
            const result = await memory.append(params.fact, {
                sessionId,
                ...(params.runId === undefined ? {} : { runId: params.runId }),
            });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
        },
    });
    const curate = defineTool({
        name: "memory_curate",
        label: "Curate Memory",
        description: "Add deduplicated long-term facts to MEMORY.md after reading it. Every source must be formatted exactly as session:ID, run:ID, or file:workspace/path.md.",
        promptSnippet: "Curate high-value sourced facts into MEMORY.md",
        promptGuidelines: [
            "Read MEMORY.md immediately before calling memory_curate and use its exact SHA-256.",
            "Format every source as session:ID, run:ID, or file:workspace/path.md; plain paths and prose sources are invalid.",
        ],
        parameters: curateParameters,
        executionMode: "sequential",
        execute: async (_toolCallId, params, signal) => {
            throwIfAborted(signal);
            const result = await memory.curate(params.expectedSha256, params.entries);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
        },
    });
    return [append, curate];
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}
//# sourceMappingURL=memory-tools.js.map