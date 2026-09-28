import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";

import { LlmSettingsService } from "../../src/settings/llm-settings-service.js";
import { initializePsporeHome } from "../../src/storage/home.js";

/** Real OpenAI-compatible SSE, paused by the consumer instead of wall-clock guesses. */
export async function articleApi() {
  const pending: ServerResponse[] = [];
  const waiters: Array<(response: ServerResponse) => void> = [];
  const requests: Record<string, unknown>[] = [];
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      requests.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.flushHeaders();
      const waiter = waiters.shift();
      if (waiter) waiter(response);
      else pending.push(response);
    })().catch((error: unknown) => {
      errors.push(error);
      response.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test API address");
  return {
    requests,
    errors,
    async configure(home: string) {
      const { paths } = await initializePsporeHome(home);
      await new LlmSettingsService(home, paths).save({
        provider: "custom-openai", model: "article-fixture", customModel: true,
        api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`,
        thinking: "off", permissionMode: "ask_risky",
        apiKey: "local-test-placeholder", clearApiKey: false, clearCookie: false,
      });
      return paths;
    },
    next(): Promise<ServerResponse> {
      const response = pending.shift();
      return response ? Promise.resolve(response) : new Promise((resolve) => waiters.push(resolve));
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export function toolChunk(response: ServerResponse, id: string, args: string, first = true): void {
  chunk(response, { tool_calls: [{ index: 0, ...(first ? { id, type: "function" } : {}),
    function: { ...(first ? { name: "article" } : {}), arguments: args } }] });
}

export function finishTool(response: ServerResponse): void {
  chunk(response, {}, "tool_calls");
  response.end("data: [DONE]\n\n");
}

export function finishText(response: ServerResponse): void {
  chunk(response, { content: "已在文稿面板完成。" });
  chunk(response, {}, "stop");
  response.end("data: [DONE]\n\n");
}

function chunk(response: ServerResponse, delta: Record<string, unknown>, finishReason: string | null = null): void {
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-article-fixture", object: "chat.completion.chunk", created: 0, model: "article-fixture",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
}

export async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
