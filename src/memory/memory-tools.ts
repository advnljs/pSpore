import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { MemoryService } from "./memory-service.js";

const appendParameters = Type.Object(
  {
    fact: Type.String({ minLength: 1, maxLength: 2_000 }),
    runId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);

const curateParameters = Type.Object(
  {
    expectedSha256: Type.String({ minLength: 64, maxLength: 64 }),
    entries: Type.Array(
      Type.Object(
        {
          fact: Type.String({ minLength: 1, maxLength: 2_000 }),
          sources: Type.Array(Type.String({ minLength: 1, maxLength: 255 }), { minItems: 1, maxItems: 20 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 50 },
    ),
  },
  { additionalProperties: false },
);

export function createMemoryTools(sessionId: string, memory: MemoryService): readonly ToolDefinition[] {
  const append = defineTool({
    name: "memory_append",
    label: "Append Memory",
    description: "Append one brief sourced fact to today's durable memory log. Never store credentials or raw tool output.",
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
    description:
      "Add deduplicated, explicitly sourced long-term facts to MEMORY.md after checking its SHA-256. Read MEMORY.md first.",
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}
