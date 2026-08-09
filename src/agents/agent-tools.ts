import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AgentManager } from "./agent-manager.js";
import type { AgentMessage, AgentRecord } from "./types.js";

const budget = Type.Object(
  {
    maxTurns: Type.Integer({ minimum: 1, maximum: 10_000 }),
    maxToolCalls: Type.Integer({ minimum: 1, maximum: 100_000 }),
    maxInputTokens: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
    maxOutputTokens: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
    maxChildren: Type.Integer({ minimum: 0, maximum: 1_000 }),
    maxCostUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  },
  { additionalProperties: false },
);

const spawnParameters = Type.Object(
  {
    objective: Type.String({ minLength: 1, maxLength: 8_000 }),
    cwd: Type.String({ minLength: 1, maxLength: 4_096 }),
    workspaceMode: Type.Union([Type.Literal("shared-read"), Type.Literal("shared-write")]),
    budget,
  },
  { additionalProperties: false },
);

const sendParameters = Type.Object(
  {
    agentId: Type.String({ minLength: 1, maxLength: 128 }),
    message: Type.String({ minLength: 1, maxLength: 8_000 }),
    mode: Type.Union([Type.Literal("steer"), Type.Literal("follow_up"), Type.Literal("next")]),
  },
  { additionalProperties: false },
);

const joinParameters = Type.Object(
  {
    agentIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 32 }),
    timeoutMs: Type.Integer({ minimum: 1, maximum: 600_000 }),
  },
  { additionalProperties: false },
);

const cancelParameters = Type.Object(
  {
    agentId: Type.String({ minLength: 1, maxLength: 128 }),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
  },
  { additionalProperties: false },
);

export function createAgentTools(sessionId: string, manager: () => AgentManager): readonly ToolDefinition[] {
  const spawn = defineTool<typeof spawnParameters, { agent: AgentRecord }>({
    name: "agent_spawn",
    label: "Spawn Agent",
    description: "Create a bounded child agent and return immediately. Delegate a finite objective and explicit budget.",
    parameters: spawnParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      throwIfAborted(signal);
      const agents = manager();
      const agent = await agents.spawn({
        parentId: agents.parentIdForSession(sessionId),
        objective: params.objective,
        cwd: params.cwd,
        workspaceMode: params.workspaceMode,
        budget: params.budget,
      });
      return { content: [{ type: "text", text: JSON.stringify(agent, null, 2) }], details: { agent } };
    },
  });

  const send = defineTool<typeof sendParameters, { message: AgentMessage }>({
    name: "agent_send",
    label: "Send Agent Message",
    description: "Send steer/follow-up/next input to a direct child, or use agentId=parent from a child.",
    parameters: sendParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      throwIfAborted(signal);
      const agents = manager();
      const message = await agents.send({
        senderId: agents.parentIdForSession(sessionId),
        recipientId: params.agentId,
        text: params.message,
        mode: params.mode,
      });
      return { content: [{ type: "text", text: JSON.stringify(message, null, 2) }], details: { message } };
    },
  });

  const join = defineTool<typeof joinParameters, { agents: AgentRecord[] }>({
    name: "agent_join",
    label: "Join Agents",
    description: "Wait for direct child agents and return their bounded structured results, without copying full transcripts.",
    parameters: joinParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      throwIfAborted(signal);
      const agents = manager();
      const parentId = agents.parentIdForSession(sessionId);
      const records = agents.list();
      for (const id of params.agentIds) {
        if (records.find((record) => record.id === id)?.parentId !== parentId) {
          throw new Error(`Agent ${id} is not a direct child of ${parentId}`);
        }
      }
      const joined = await agents.join(params.agentIds, params.timeoutMs, signal);
      return { content: [{ type: "text", text: JSON.stringify(joined, null, 2) }], details: { agents: joined } };
    },
  });

  const cancel = defineTool<typeof cancelParameters, { agent: AgentRecord }>({
    name: "agent_cancel",
    label: "Cancel Agent",
    description: "Cancel a direct child agent and cascade cancellation to its descendants.",
    parameters: cancelParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      throwIfAborted(signal);
      const agents = manager();
      const parentId = agents.parentIdForSession(sessionId);
      if (agents.list().find((record) => record.id === params.agentId)?.parentId !== parentId) {
        throw new Error(`Agent ${params.agentId} is not a direct child of ${parentId}`);
      }
      const agent = await agents.cancel(params.agentId, params.reason ?? `cancelled by parent ${parentId}`);
      return { content: [{ type: "text", text: JSON.stringify(agent, null, 2) }], details: { agent } };
    },
  });

  return [spawn, send, join, cancel];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Agent tool aborted");
}
