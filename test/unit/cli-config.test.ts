import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { isEntrypoint, resolveInvokedName, runCli } from "../../src/cli/main.js";
import { LlmSettingsService } from "../../src/settings/llm-settings-service.js";
import { psporePaths } from "../../src/storage/home.js";
import { PSPORE_VERSION } from "../../src/version.js";

test("CLI config supports the same provider presets and custom OpenAI settings as the GUI", async () => {
  const home = await mkdtemp(join(tmpdir(), "pspore-cli-config-"));
  try {
    const initial = await captureStdout(() => runCli(["--home", home, "config", "show"]));
    assert.match(initial, /Provider: deepseek/);
    assert.match(initial, /API key: not configured/);

    await captureStdout(() => runCli(["--home", home, "config", "set", "openai", "gpt-5.6-terra", "low"]));
    const service = new LlmSettingsService(home, psporePaths(home));
    assert.deepEqual(await service.get(), {
      version: 1,
      provider: "openai",
      model: "gpt-5.6-terra",
      baseUrl: "",
      api: "provider-default",
      thinking: "low",
      customModel: false,
      hasApiKey: false,
    });

    await captureStdout(() => runCli([
      "--home",
      home,
      "config",
      "set",
      "custom-openai",
      "gateway-model",
      "https://gateway.example.com/v1",
      "responses",
      "off",
    ]));
    const custom = await service.get();
    assert.equal(custom.provider, "custom-openai");
    assert.equal(custom.model, "gateway-model");
    assert.equal(custom.api, "openai-responses");
    assert.equal(custom.customModel, true);
    const modelsSource = await readFile(join(home, "state", "pi", "models.json"), "utf8");
    assert.match(modelsSource, /gateway-model/);

    await assert.rejects(
      () => captureStdout(() => runCli(["--home", home, "config", "set", "anthropic"])),
      /deepseek, openai, or custom-openai/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("CLI entrypoint recognizes the symlink created by npm", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pspore-cli-entrypoint-"));
  const target = fileURLToPath(import.meta.url);
  const link = join(directory, "pspore");
  try {
    await symlink(target, link);
    assert.equal(isEntrypoint(link, pathToFileURL(target).href), true);
    assert.equal(isEntrypoint(undefined, pathToFileURL(target).href), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("npm package installs both the package name and the short pspore command", async () => {
  const manifestPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    name?: string;
    version?: string;
    bin?: Record<string, string>;
  };
  assert.equal(manifest.name, "p-spore");
  assert.equal(manifest.version, PSPORE_VERSION);
  // `npm install --global p-spore` must expose a command matching the package name.
  assert.equal(manifest.bin?.["p-spore"], "dist/cli/main.js");
  assert.deepEqual(manifest.bin, {
    pspore: "dist/cli/main.js",
    "p-spore": "dist/cli/main.js",
  });
});

// Importing the module cannot catch initialization-order faults that only surface when the
// file is executed directly, the way both npm bin symlinks execute it.
test("running the CLI as an entrypoint renders help without initialization errors", async () => {
  const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
  const { stdout, stderr } = await execFileAsync(tsx, [cli, "--help"]);
  assert.equal(stderr, "");
  assert.match(stdout, /Usage: pspore \[--home PATH\] <command>/);
  assert.match(stdout, /^pSpore \d+\.\d+\.\d+ — Linux local agent core/);
});

test("help and hints echo back whichever bin alias was invoked", () => {
  assert.equal(resolveInvokedName("/usr/local/bin/p-spore"), "p-spore");
  assert.equal(resolveInvokedName("/usr/local/bin/pspore"), "pspore");
  assert.equal(resolveInvokedName("/opt/app/dist/cli/main.js"), "pspore");
  assert.equal(resolveInvokedName(undefined), "pspore");
});

async function captureStdout(run: () => Promise<number>): Promise<string> {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(await run(), 0);
    return output;
  } finally {
    process.stdout.write = original;
  }
}
