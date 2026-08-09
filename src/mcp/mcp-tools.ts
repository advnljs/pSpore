import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

import type { McpManager } from "./mcp-manager.js";
import type { McpCallDetails, McpToolDescriptor } from "./types.js";

const discoverParameters = Type.Object(
  { serverId: Type.String({ minLength: 1, maxLength: 64 }) },
  { additionalProperties: false },
);

const callParameters = Type.Object(
  {
    serverId: Type.String({ minLength: 1, maxLength: 64 }),
    toolName: Type.String({ minLength: 1, maxLength: 128 }),
    arguments: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

export function createMcpTools(manager: () => McpManager): readonly ToolDefinition[] {
  const discover = defineTool<typeof discoverParameters, { tools: McpToolDescriptor[] }>({
    name: "mcp_discover",
    label: "Discover MCP",
    description:
      "Lazily connect to one explicitly trusted MCP server and activate its allowed tool schemas. New sessions receive normalized dynamic tools; this session can use mcp_call.",
    parameters: discoverParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const tools = await manager().discover(params.serverId, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(tools, null, 2) }],
        details: { tools },
      };
    },
  });

  const call = defineTool<typeof callParameters, McpCallDetails>({
    name: "mcp_call",
    label: "Call MCP Tool",
    description:
      "Call an allowed tool on an explicitly trusted MCP server. Use mcp_discover first when you need its schema in the current session.",
    parameters: callParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const result = await manager().call(params.serverId, params.toolName, params.arguments, signal);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  });

  const dynamic = manager().listTools().map((tool) => dynamicTool(tool, manager));
  return [discover, call, ...dynamic];
}

function dynamicTool(tool: McpToolDescriptor, manager: () => McpManager): ToolDefinition {
  return defineTool({
    name: tool.normalizedName,
    label: tool.title ?? `${tool.serverId}: ${tool.name}`,
    description: tool.description ?? `Call MCP tool ${tool.name} on server ${tool.serverId}.`,
    parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema as TSchema),
    executionMode: tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true
      ? "parallel"
      : "sequential",
    execute: async (_toolCallId, params, signal) => {
      const result = await manager().call(tool.serverId, tool.name, params, signal);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  });
}
