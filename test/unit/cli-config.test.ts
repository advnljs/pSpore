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
    assert.match(initial, /Cookie: not configured/);

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
      permissionMode: "ask_risky",
      autoCompactionEnabled: true,
      autoCompactionTriggerTokens: 100_000,
      autoCompactionReserveTokens: 16_384,
      autoCompactionKeepRecentTokens: 20_000,
      hasApiKey: false,
      hasCookie: false,
      configPath: join(home, "config.json"),
      apiKeyPath: join(home, "credentials", "openai.api-key"),
      cookiePath: join(home, "credentials", "openai.cookie"),
      modelsPath: join(home, "state", "pi", "models.json"),
    });

    await captureStdout(() => runCli(["--home", home, "config", "compact", "off", "24576", "12288", "80000"]));
    const compact = await service.get();
    assert.equal(compact.autoCompactionEnabled, false);
    assert.equal(compact.autoCompactionTriggerTokens, 80_000);
    assert.equal(compact.autoCompactionReserveTokens, 24_576);
    assert.equal(compact.autoCompactionKeepRecentTokens, 12_288);

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
    // config.json is authoritative: the endpoint override must round-trip there,
    // not only through the derived Pi catalog.
    const storedConfig = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    assert.equal(storedConfig.model.baseUrl, "https://gateway.example.com/v1");
    assert.equal(storedConfig.model.api, "openai-responses");
    assert.equal(storedConfig.model.customModel, true);
    assert.equal(storedConfig.model.apiKeyFile, join(home, "credentials", "custom-openai.api-key"));

    await assert.rejects(
      () => captureStdout(() => runCli(["--home", home, "config", "set", "anthropic"])),
      /deepseek, openai, or custom-openai/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("CLI can bypass approvals and restore an asking policy", async () => {
  const home = await mkdtemp(join(tmpdir(), "pspore-cli-permissions-"));
  try {
    const initial = await captureStdout(() => runCli(["--home", home, "config", "show"]));
    assert.match(initial, /Permissions: ask_risky/);

    const bypassed = await captureStdout(() => runCli(["--home", home, "config", "permissions", "bypass"]));
    assert.match(bypassed, /Permissions: allow_all — bypass all approvals/);
    const configPath = join(home, "config.json");
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).permissions.mode, "allow_all");

    await captureStdout(() => runCli(["--home", home, "config", "permissions", "ask_all"]));
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).permissions.mode, "ask_all");
    // The model settings must survive a permission-only change.
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).permissions.rules.length, 0);

    await assert.rejects(
      () => captureStdout(() => runCli(["--home", home, "config", "permissions", "yolo"])),
      /Permission mode must be one of/,
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

test("a fresh home reports no configured model until settings are saved", async () => {
  const home = await mkdtemp(join(tmpdir(), "pspore-first-run-"));
  try {
    // The TUI always initializes the home before asking, so mirror that order here.
    await captureStdout(() => runCli(["--home", home, "init"]));
    const service = new LlmSettingsService(home, psporePaths(home));
    // Matches the daemon gate that answers prompts with model_not_configured.
    assert.equal(await service.isModelConfigured(), false);

    await captureStdout(() => runCli(["--home", home, "config", "set", "deepseek", "deepseek-v4-flash", "off"]));
    assert.equal(await service.isModelConfigured(), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// Importing the module cannot catch initialization-order faults that only surface when the
// file is executed directly, the way both npm bin symlinks execute it.
test("running the CLI as an entrypoint renders help without initialization errors", async () => {
  const home = await mkdtemp(join(tmpdir(), "pspore-help-"));
  try {
    // An unconfigured home leads with the setup pointer, then still prints the full help.
    const unconfigured = await runCliProcess(["--home", home, "--help"]);
    assert.equal(unconfigured.stderr, "");
    assert.match(unconfigured.stdout, /^No model is configured yet/);
    assert.match(unconfigured.stdout, /pspore setup/);
    assert.match(unconfigured.stdout, /Usage: pspore \[--home PATH\] <command>/);
    assert.match(unconfigured.stdout, /^\s*setup\s+Guided model setup/m);

    await captureStdout(() => runCli(["--home", home, "config", "set", "deepseek", "deepseek-v4-flash", "off"]));

    // Once configured the pointer disappears and help leads with the banner again.
    const configured = await runCliProcess(["--home", home, "--help"]);
    assert.equal(configured.stderr, "");
    assert.doesNotMatch(configured.stdout, /No model is configured yet/);
    assert.match(configured.stdout, /^pSpore \d+\.\d+\.\d+ — Linux local agent core/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function runCliProcess(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
  return execFileAsync(tsx, [cli, ...args]);
}

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
