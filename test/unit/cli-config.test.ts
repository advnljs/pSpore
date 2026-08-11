import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { isEntrypoint, runCli } from "../../src/cli/main.js";
import { LlmSettingsService } from "../../src/settings/llm-settings-service.js";
import { psporePaths } from "../../src/storage/home.js";

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

test("npm package keeps the canonical pspore bin mapping", async () => {
  const manifestPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    bin?: Record<string, string>;
  };
  assert.deepEqual(manifest.bin, { pspore: "dist/cli/main.js" });
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
