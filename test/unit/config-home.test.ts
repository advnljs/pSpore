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

  test("fails rather than repairing a malformed existing config", async () => {
    const home = await mkdtemp(join(tmpdir(), "pspore-bad-home-"));
    roots.push(home);
    const configPath = join(home, "config.json");
    await writeFile(configPath, "{broken", { mode: 0o600 });
    await chmod(home, 0o700);
    await assert.rejects(initializePsporeHome(home), /JSON/);
  });
});
