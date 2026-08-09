import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { defaultConfig, parseConfig } from "../../src/config/config.js";
import { initializePsporeHome, loadConfig } from "../../src/storage/home.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("config and home initialization", () => {
  test("creates private defaults once and never overwrites workspace files", async () => {
    const home = await mkdtemp(join(tmpdir(), "pspore-home-"));
    roots.push(home);
    const first = await initializePsporeHome(home);
    assert.ok(first.created.some((path) => path.endsWith("config.json")));
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    assert.equal((await stat(first.paths.config)).mode & 0o777, 0o600);

    const agents = join(first.paths.workspace, "AGENTS.md");
    await writeFile(agents, "# User-owned rules\n", "utf8");
    const second = await initializePsporeHome(home);
    assert.equal(await readFile(agents, "utf8"), "# User-owned rules\n");
    assert.equal(second.created.length, 0);
    assert.equal((await loadConfig(home)).version, 1);
  });

  test("rejects unknown keys and invalid security modes", async () => {
    const home = "/tmp/example-home";
    const base = defaultConfig(home);
    assert.throws(() => parseConfig({ ...base, typo: true }, home), /unknown keys: typo/);
    assert.throws(
      () => parseConfig({ ...base, permissions: { ...base.permissions, mode: "unsafe" } }, home),
      /must be one of/,
    );
  });

  test("strictly parses MCP transports without accepting inline secrets", () => {
    const home = "/tmp/example-home";
    const base = defaultConfig(home);
    const parsed = parseConfig({
      ...base,
      mcpServers: [
        {
          id: "local_docs",
          enabled: true,
          trust: "trusted-local",
          transport: {
            type: "stdio",
            command: "node",
            args: ["server.mjs"],
            cwd: "mcp",
            envRefs: { API_TOKEN: "DOCS_API_TOKEN" },
          },
          allowedTools: ["search"],
          deniedTools: ["publish"],
        },
      ],
    }, home);
    assert.equal(parsed.mcpServers[0]?.transport.type, "stdio");
    assert.equal(parsed.mcpServers[0]?.idleTimeoutMs, 60_000);
    assert.equal(
      parsed.mcpServers[0]?.transport.type === "stdio" ? parsed.mcpServers[0].transport.cwd : undefined,
      "/tmp/example-home/mcp",
    );

    assert.throws(
      () => parseConfig({
        ...base,
        mcpServers: [{
          id: "remote",
          enabled: true,
          trust: "trusted-local",
          transport: { type: "streamable-http", url: "https://example.com/mcp", headers: { Authorization: "secret" } },
        }],
      }, home),
      /unknown keys: headers/,
    );
    assert.throws(
      () => parseConfig({
        ...base,
        mcpServers: [{
          id: "remote",
          enabled: true,
          trust: "trusted-local",
          transport: { type: "streamable-http", url: "http:\/\/example.com/mcp" },
        }],
      }, home),
      /must use https/,
    );
    assert.throws(
      () => parseConfig({
        ...base,
        mcpServers: [
          { id: "same", enabled: false, trust: "trusted-local", transport: { type: "stdio", command: "one" } },
          { id: "same", enabled: false, trust: "trusted-local", transport: { type: "stdio", command: "two" } },
        ],
      }, home),
      /duplicate ids/,
    );
  });

  test("pins host plugin activation to an exact digest and capability grant", () => {
    const home = "/tmp/example-home";
    const base = defaultConfig(home);
    const digest = "a".repeat(64);
    const parsed = parseConfig({
      ...base,
      plugins: [{
        name: "fixture-plugin",
        enabled: true,
        digest,
        grantedCapabilities: ["network.http"],
      }],
    }, home);
    assert.deepEqual(parsed.plugins, [{
      name: "fixture-plugin",
      enabled: true,
      digest,
      grantedCapabilities: ["network.http"],
    }]);
    assert.throws(
      () => parseConfig({
        ...base,
        plugins: [{ name: "fixture-plugin", enabled: true, digest: "latest", grantedCapabilities: [] }],
      }, home),
      /lowercase SHA-256/,
    );
    assert.throws(
      () => parseConfig({
        ...base,
        plugins: [
          { name: "same", enabled: true, digest, grantedCapabilities: [] },
          { name: "same", enabled: false, digest, grantedCapabilities: [] },
        ],
      }, home),
      /duplicate names/,
    );
  });

  test("fails rather than repairing a malformed existing config", async () => {
    const home = await mkdtemp(join(tmpdir(), "pspore-bad-home-"));
    roots.push(home);
    const configPath = join(home, "config.json");
    await writeFile(configPath, "{broken", { mode: 0o600 });
    await chmod(home, 0o700);
    await assert.rejects(initializePsporeHome(home), /JSON/);
  });
});
