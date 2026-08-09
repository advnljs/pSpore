import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";

import { McpManager, type McpConnectionFactory } from "../../src/mcp/mcp-manager.js";
import { createMcpTools } from "../../src/mcp/mcp-tools.js";
import type { McpServerConfig } from "../../src/mcp/types.js";

const roots: string[] = [];
const managers: McpManager[] = [];

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map(async (manager) => manager.stop()));
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("MCP lazy adapter", () => {
  test("lazily discovers a real stdio server, activates schemas, bounds output, and aborts calls", async () => {
    const root = await temporaryRoot();
    const marker = join(root, "server-starts.log");
    const manager = await McpManager.create({
      configs: [stdioConfig()],
      artifactRoot: join(root, "artifacts"),
      auditPath: join(root, "audit", "mcp.jsonl"),
      environment: { TEST_MCP_MARKER: marker },
      maxResultBytes: 2_048,
      clock: () => new Date(),
      idFactory: sequence("mcp"),
    });
    managers.push(manager);

    assert.equal(manager.listServers()[0]?.status, "idle");
    await assert.rejects(access(marker));
    assert.deepEqual(createMcpTools(() => manager).map((tool) => tool.name), ["mcp_discover", "mcp_call"]);

    const discovered = await manager.discover("fixture");
    assert.deepEqual(discovered.map((tool) => tool.name), ["echo", "large-result", "slow"]);
    assert.deepEqual(discovered.map((tool) => tool.normalizedName), [
      "mcp__fixture__echo",
      "mcp__fixture__large-result",
      "mcp__fixture__slow",
    ]);
    assert.equal((await readFile(marker, "utf8")).trim(), "started");
    assert.deepEqual(createMcpTools(() => manager).map((tool) => tool.name), [
      "mcp_discover",
      "mcp_call",
      "mcp__fixture__echo",
      "mcp__fixture__large-result",
      "mcp__fixture__slow",
    ]);

    const echo = await manager.call("fixture", "echo", { value: "not-written-to-audit" });
    assert.match(echo.text, /not-written-to-audit/);
    assert.equal(echo.details.truncated, false);
    await assert.rejects(manager.call("fixture", "mutate", {}), /not allowed or does not exist/);

    const large = await manager.call("fixture", "mcp__fixture__large-result", {});
    assert.equal(large.details.truncated, true);
    assert.ok(large.details.artifactPath);
    assert.equal((await stat(large.details.artifactPath ?? "missing")).mode & 0o777, 0o600);
    assert.match(await readFile(large.details.artifactPath ?? "missing", "utf8"), /x{1000}/);

    const controller = new AbortController();
    const slow = manager.call("fixture", "slow", {}, controller.signal);
    setTimeout(() => controller.abort(new Error("test abort")), 25).unref();
    await assert.rejects(slow, /test abort|aborted/i);
    assert.equal(manager.listServers()[0]?.status, "ready");

    const audit = await readFile(join(root, "audit", "mcp.jsonl"), "utf8");
    assert.doesNotMatch(audit, /not-written-to-audit/);
    assert.match(audit, /"outcome":"aborted"/);
    await waitFor(() => manager.listServers()[0]?.status === "idle");
    const startsBeforeReconnect = (await readFile(marker, "utf8")).trim().split("\n").length;
    await manager.call("fixture", "echo", { value: "reconnected" });
    await waitFor(async () => (await readFile(marker, "utf8")).trim().split("\n").length > startsBeforeReconnect);
    await manager.stop();
    assert.equal(manager.listServers()[0]?.status, "stopped");
  });

  test("backs off failed connections exponentially and redacts referenced secrets", async () => {
    const root = await temporaryRoot();
    let now = Date.parse("2026-08-10T00:00:00.000Z");
    let attempts = 0;
    const factory: McpConnectionFactory = async () => {
      attempts += 1;
      throw new Error("cannot connect with top-secret-value");
    };
    const config = stdioConfig();
    config.transport.type === "stdio" && (config.transport.envRefs = { TOKEN: "SOURCE_TOKEN" });
    const manager = await McpManager.create({
      configs: [config],
      artifactRoot: join(root, "artifacts"),
      auditPath: join(root, "audit", "mcp.jsonl"),
      environment: { SOURCE_TOKEN: "top-secret-value" },
      connectionFactory: factory,
      initialBackoffMs: 100,
      maxBackoffMs: 1_000,
      clock: () => new Date(now),
    });
    managers.push(manager);

    await assert.rejects(manager.discover("fixture"), /REDACTED/);
    assert.equal(attempts, 1);
    assert.equal(manager.listServers()[0]?.status, "backoff");
    assert.doesNotMatch(manager.listServers()[0]?.lastError ?? "", /top-secret-value/);
    assert.match(manager.listServers()[0]?.lastError ?? "", /REDACTED/);
    await assert.rejects(manager.discover("fixture"), /backoff/);
    assert.equal(attempts, 1);

    now += 101;
    await assert.rejects(manager.discover("fixture"), /REDACTED/);
    assert.equal(attempts, 2);
    assert.equal(manager.listServers()[0]?.retryAt, "2026-08-10T00:00:00.301Z");
  });
});

function stdioConfig(): McpServerConfig {
  const fixture = fileURLToPath(new URL("../fixtures/fake-mcp-server.ts", import.meta.url));
  return {
    id: "fixture",
    enabled: true,
    trust: "trusted-local",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: ["--import", "tsx", fixture],
      cwd: dirname(dirname(dirname(fixture))),
      envRefs: { FAKE_MCP_MARKER: "TEST_MCP_MARKER" },
    },
    allowedTools: ["echo", "large-result", "slow"],
    deniedTools: ["mutate"],
    idleTimeoutMs: 80,
    requestTimeoutMs: 2_000,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pspore-mcp-"));
  roots.push(root);
  return root;
}

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for MCP state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
