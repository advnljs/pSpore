import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LlmSettingsService } from "../../src/settings/llm-settings-service.js";
import { initializePsporeHome } from "../../src/storage/home.js";

test("desktop settings persist model endpoint and API key without embedding the secret", async () => {
  const home = await mkdtemp(join(tmpdir(), "pspore-desktop-settings-"));
  try {
    const { paths } = await initializePsporeHome(home);
    const service = new LlmSettingsService(home, paths);
    assert.deepEqual(await service.get(), {
      version: 1,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "",
      api: "provider-default",
      thinking: "off",
      customModel: false,
      permissionMode: "ask_risky",
      hasApiKey: false,
      hasCookie: false,
    });

    const secret = "unit-test-key-that-must-not-enter-models-json";
    const saved = await service.save({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "",
      api: "provider-default",
      thinking: "off",
      customModel: false,
      permissionMode: "ask_risky",
      apiKey: secret,
      clearApiKey: false,
      clearCookie: false,
    });
    assert.equal(saved.hasApiKey, true);
    const config = JSON.parse(await readFile(paths.config, "utf8"));
    assert.deepEqual(config.model, { provider: "deepseek", model: "deepseek-v4-flash", thinking: "off" });
    const modelsSource = await readFile(join(paths.agentDir, "models.json"), "utf8");
    assert.doesNotMatch(modelsSource, new RegExp(secret));
    assert.match(modelsSource, /deepseek\.api-key/);
    const credentialPath = join(paths.credentials, "deepseek.api-key");
    assert.equal(await readFile(credentialPath, "utf8"), secret);
    assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);

    const cleared = await service.save({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "",
      api: "provider-default",
      thinking: "low",
      customModel: false,
      permissionMode: "ask_risky",
      clearApiKey: true,
      clearCookie: false,
    });
    assert.equal(cleared.hasApiKey, false);
    await assert.rejects(() => access(credentialPath), /ENOENT/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("desktop settings can register an explicit OpenAI-compatible custom model", async () => {
  const home = await mkdtemp(join(tmpdir(), "pspore-desktop-custom-model-"));
  try {
    const { paths } = await initializePsporeHome(home);
    const service = new LlmSettingsService(home, paths);
    const saved = await service.save({
      provider: "custom-openai",
      model: "reasoner-v1",
      baseUrl: "http://127.0.0.1:8080/v1",
      api: "openai-completions",
      thinking: "off",
      customModel: true,
      permissionMode: "ask_risky",
      apiKey: "local-only",
      clearApiKey: false,
      clearCookie: false,
    });
    assert.equal(saved.customModel, true);
    assert.equal(saved.api, "openai-completions");
    const models = JSON.parse(await readFile(join(paths.agentDir, "models.json"), "utf8"));
    assert.deepEqual(models.providers["custom-openai"].models, [{ id: "reasoner-v1", name: "reasoner-v1" }]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("desktop settings persist an LLM proxy cookie as a private header reference", async () => {
  const home = await mkdtemp(join(tmpdir(), "pspore-desktop-cookie-"));
  try {
    const { paths } = await initializePsporeHome(home);
    const service = new LlmSettingsService(home, paths);
    const cookie = "session=unit-test-cookie-that-must-not-enter-models-json";
    const saved = await service.save({
      provider: "custom-openai",
      model: "proxy-model",
      baseUrl: "http://127.0.0.1:8080/v1",
      api: "openai-completions",
      thinking: "off",
      customModel: true,
      permissionMode: "ask_risky",
      cookie,
      clearApiKey: false,
      clearCookie: false,
    });
    assert.equal(saved.hasCookie, true);
    assert.equal(saved.hasApiKey, false);
    const modelsSource = await readFile(join(paths.agentDir, "models.json"), "utf8");
    assert.doesNotMatch(modelsSource, /unit-test-cookie/);
    assert.match(modelsSource, /"Cookie"/);
    assert.match(modelsSource, /custom-openai\.cookie/);
    const cookiePath = join(paths.credentials, "custom-openai.cookie");
    assert.equal(await readFile(cookiePath, "utf8"), cookie);
    assert.equal((await stat(cookiePath)).mode & 0o777, 0o600);

    const cleared = await service.save({
      provider: "custom-openai",
      model: "proxy-model",
      baseUrl: "http://127.0.0.1:8080/v1",
      api: "openai-completions",
      thinking: "off",
      customModel: true,
      permissionMode: "ask_risky",
      clearApiKey: false,
      clearCookie: true,
    });
    assert.equal(cleared.hasCookie, false);
    const after = JSON.parse(await readFile(join(paths.agentDir, "models.json"), "utf8"));
    assert.equal(after.providers["custom-openai"].headers, undefined);
    await assert.rejects(() => access(cookiePath), /ENOENT/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("permission mode round-trips through shared settings and reaches the daemon config", async () => {
  const home = await mkdtemp(join(tmpdir(), "pspore-permission-mode-"));
  try {
    const { paths } = await initializePsporeHome(home);
    const service = new LlmSettingsService(home, paths);
    assert.equal((await service.get()).permissionMode, "ask_risky");

    const bypassed = await service.save({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "",
      api: "provider-default",
      thinking: "off",
      customModel: false,
      permissionMode: "allow_all",
      clearApiKey: false,
      clearCookie: false,
    });
    assert.equal(bypassed.permissionMode, "allow_all");
    const config = JSON.parse(await readFile(paths.config, "utf8"));
    assert.equal(config.permissions.mode, "allow_all");
    // Bypassing approvals must not silently discard the rest of the policy.
    assert.deepEqual(config.permissions.rules, []);
    assert.equal(config.permissions.approvalTimeoutMs, 300_000);

    const restored = await service.save({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "",
      api: "provider-default",
      thinking: "off",
      customModel: false,
      permissionMode: "ask_all",
      clearApiKey: false,
      clearCookie: false,
    });
    assert.equal(restored.permissionMode, "ask_all");
    assert.equal(JSON.parse(await readFile(paths.config, "utf8")).permissions.mode, "ask_all");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
