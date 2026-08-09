import { appendFile } from "node:fs/promises";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const marker = process.env["FAKE_MCP_MARKER"];
if (marker) await appendFile(marker, "started\n", { encoding: "utf8", mode: 0o600 });

const server = new Server(
  { name: "pspore-fake-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo one bounded value.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: "large-result",
      description: "Return a large result for artifact truncation tests.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: "slow",
      description: "Wait until the request is cancelled.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "mutate",
      description: "A denied mutation fixture.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { destructiveHint: true },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name === "echo") {
    const value = request.params.arguments?.["value"];
    return { content: [{ type: "text", text: typeof value === "string" ? value : "" }] };
  }
  if (request.params.name === "large-result") {
    return { content: [{ type: "text", text: "x".repeat(32_000) }] };
  }
  if (request.params.name === "slow") {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 60_000);
      timer.unref();
      extra.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(extra.signal.reason instanceof Error ? extra.signal.reason : new Error("cancelled"));
      }, { once: true });
    });
    return { content: [{ type: "text", text: "unexpected completion" }] };
  }
  return { isError: true, content: [{ type: "text", text: `unknown tool: ${request.params.name}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);

const close = () => void server.close().finally(() => process.exit(0));
process.once("SIGINT", close);
process.once("SIGTERM", close);
