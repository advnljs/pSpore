import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { defineTool, ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { RuntimeEvent, ToolGate } from "../../src/domain/runtime.js";
import { PiRuntimeAdapter } from "../../src/pi/pi-runtime-adapter.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

async function fixture(
  options: {
    tokensPerSecond?: number;
    tokenSize?: { min: number; max: number };
    toolGate?: ToolGate;
    createTools?: () => readonly ToolDefinition[];
    createSkillPaths?: () => readonly string[] | Promise<readonly string[]>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pspore-pi-contract-"));
  const faux = fauxProvider({
    provider: `pspore-faux-${Math.random().toString(36).slice(2)}`,
    ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
    ...(options.tokenSize === undefined ? {} : { tokenSize: options.tokenSize }),
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const adapter = await PiRuntimeAdapter.create({
    agentDir: join(root, "agent"),
    sessionRoot: join(root, "sessions"),
    modelRuntime,
    resolveModel: () => faux.getModel(),
    ...(options.toolGate ? { toolGate: options.toolGate } : {}),
    ...(options.createTools ? { createTools: options.createTools } : {}),
    ...(options.createSkillPaths ? { createSkillPaths: options.createSkillPaths } : {}),
  });
  cleanups.push(async () => {
    await adapter.disposeAll();
    await rm(root, { recursive: true, force: true });
  });
  return { adapter, faux, root };
}

const spec = (cwd: string) => ({
  sessionId: "main",
  workspaceId: "default",
  cwd,
  model: { provider: "ignored-by-test-resolver", model: "faux" },
  systemPrompt: "You are a deterministic contract-test agent.",
});

describe("PiRuntimeAdapter contract against Pi v0.84.1", () => {
  test("materializes a private Pi JSONL file before returning a new session", async () => {
    const { adapter, root } = await fixture();
    const handle = await adapter.create(spec(root));
    assert.ok(handle.sessionFile);
    assert.equal((await stat(handle.sessionFile)).mode & 0o777, 0o600);
    const firstLine = (await readFile(handle.sessionFile, "utf8")).split("\n")[0];
    assert.ok(firstLine);
    const header = JSON.parse(firstLine) as { type?: string; cwd?: string };
    assert.equal(header.type, "session");
    assert.equal(header.cwd, root);
  });

  test("recreates a missing cataloged Pi JSONL file when resuming", async () => {
    const { adapter, faux, root } = await fixture();
    const handle = await adapter.create(spec(root));
    assert.ok(handle.sessionFile);
    await adapter.dispose("main");
    await rm(handle.sessionFile);

    faux.setResponses([fauxAssistantMessage("continued after repair")]);
    await adapter.resume({ ...spec(root), sessionId: "restored", sessionFile: handle.sessionFile });
    assert.equal((await stat(handle.sessionFile)).mode & 0o777, 0o600);
    await adapter.prompt("restored", "continue");
    await adapter.waitForIdle("restored");
    assert.equal(adapter.snapshot("restored").messages.at(-1)?.text, "continued after repair");
  });

  test("maps streaming, settled and provider cache usage without leaking Pi objects", async () => {
    const { adapter, faux, root } = await fixture();
    faux.setResponses([fauxAssistantMessage("hello from faux"), fauxAssistantMessage("second turn")]);
    await adapter.create(spec(root));
    const events: RuntimeEvent[] = [];
    adapter.subscribe("main", (event) => events.push(event));

    const first = await adapter.prompt("main", "hello");
    assert.equal(first.accepted, true);
    await adapter.waitForIdle("main");
    await adapter.prompt("main", "again");
    await adapter.waitForIdle("main");

    assert.ok(events.some((event) => event.type === "run.started"));
    assert.ok(events.some((event) => event.type === "message.delta"));
    assert.ok(events.some((event) => event.type === "message.completed"));
    assert.equal(events.filter((event) => event.type === "run.settled").length, 2);
    assert.ok(events.every((event) => !("agent" in event.payload)));

    const snapshot = adapter.snapshot("main");
    assert.equal(snapshot.status, "idle");
    assert.equal(snapshot.messages.at(-1)?.text, "second turn");
    assert.ok(snapshot.usage.cacheWrite > 0);
    assert.ok(snapshot.usage.cacheRead > 0);
  });

  test("emits thinking on its own transient channel and keeps it out of persisted prose", async () => {
    const { adapter, faux, root } = await fixture({ tokensPerSecond: 1_000 });
    faux.setResponses([
      fauxAssistantMessage([
        fauxThinking("private chain of thought"),
        fauxText("public final answer"),
      ]),
    ]);
    await adapter.create({ ...spec(root), thinking: "medium" as const });
    const events: RuntimeEvent[] = [];
    adapter.subscribe("main", (event) => events.push(event));

    await adapter.prompt("main", "reason separately");
    await adapter.waitForIdle("main");

    const thinking = events
      .filter((event) => event.type === "message.thinking.delta")
      .map((event) => String(event.payload["delta"] ?? ""))
      .join("");
    const text = events
      .filter((event) => event.type === "message.delta")
      .map((event) => String(event.payload["delta"] ?? ""))
      .join("");
    assert.equal(thinking, "private chain of thought");
    assert.equal(text, "public final answer");
    assert.equal(adapter.snapshot("main").messages.at(-1)?.text, "public final answer");
    assert.doesNotMatch(adapter.snapshot("main").messages.at(-1)?.text ?? "", /private chain/);
  });

  test("rebinds subscriptions after new-session and fork replacement", async () => {
    const { adapter, faux, root } = await fixture();
    faux.setResponses([
      fauxAssistantMessage("first session"),
      fauxAssistantMessage("new session"),
      fauxAssistantMessage("fork source"),
      fauxAssistantMessage("fork continuation"),
    ]);
    await adapter.create(spec(root));
    const events: RuntimeEvent[] = [];
    adapter.subscribe("main", (event) => events.push(event));

    await adapter.prompt("main", "first");
    await adapter.waitForIdle("main");
    const initialUpstreamId = adapter.snapshot("main").upstreamSessionId;

    await adapter.newSession("main");
    const newUpstreamId = adapter.snapshot("main").upstreamSessionId;
    assert.notEqual(newUpstreamId, initialUpstreamId);
    await adapter.prompt("main", "new");
    await adapter.waitForIdle("main");

    await adapter.prompt("main", "fork me");
    await adapter.waitForIdle("main");
    const userEntry = adapter.snapshot("main").entries.find((entry) => entry.role === "user" && entry.text === "fork me");
    assert.ok(userEntry?.id);
    await adapter.fork("main", userEntry.id, "at");
    const forkedUpstreamId = adapter.snapshot("main").upstreamSessionId;
    assert.notEqual(forkedUpstreamId, newUpstreamId);
    await adapter.prompt("main", "continue fork");
    await adapter.waitForIdle("main");

    assert.equal(events.filter((event) => event.type === "session.replaced").length, 2);
    assert.ok(events.some((event) => event.upstreamSessionId === forkedUpstreamId && event.type === "message.delta"));
  });

  test("persists JSONL and resumes it in a fresh adapter", async () => {
    const first = await fixture();
    first.faux.setResponses([fauxAssistantMessage("persisted")]);
    const handle = await first.adapter.create(spec(first.root));
    await first.adapter.prompt("main", "remember this");
    await first.adapter.waitForIdle("main");
    assert.ok(handle.sessionFile);

    const secondRoot = await mkdtemp(join(tmpdir(), "pspore-pi-resume-"));
    const faux = fauxProvider({ provider: `pspore-faux-${Math.random().toString(36).slice(2)}` });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const adapter = await PiRuntimeAdapter.create({
      agentDir: join(secondRoot, "agent"),
      sessionRoot: join(secondRoot, "sessions"),
      modelRuntime,
      resolveModel: () => faux.getModel(),
    });
    cleanups.push(async () => {
      await adapter.disposeAll();
      await rm(secondRoot, { recursive: true, force: true });
    });

    await adapter.resume({ ...spec(first.root), sessionId: "resumed", sessionFile: handle.sessionFile });
    const snapshot = adapter.snapshot("resumed");
    assert.ok(snapshot.messages.some((message) => message.text === "remember this"));
    assert.ok(snapshot.messages.some((message) => message.text === "persisted"));
  });

  test("fails closed before a denied tool executes", async () => {
    let executed = false;
    const dangerousTool = defineTool({
      name: "dangerous_test_tool",
      label: "Dangerous Test Tool",
      description: "Contract-only mutation tool",
      parameters: Type.Object({ value: Type.String() }),
      execute: async () => {
        executed = true;
        return { content: [{ type: "text", text: "executed" }], details: {} };
      },
    });
    const gate: ToolGate = {
      authorize: async () => ({ decision: "deny", reason: "blocked by contract policy", terminate: true }),
    };
    const { adapter, faux, root } = await fixture({ toolGate: gate, createTools: () => [dangerousTool] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("dangerous_test_tool", { value: "x" }), { stopReason: "toolUse" }),
    ]);
    await adapter.create({ ...spec(root), enabledTools: ["dangerous_test_tool"] });

    await adapter.prompt("main", "use the tool");
    await adapter.waitForIdle("main");

    assert.equal(executed, false);
    const messages = adapter.snapshot("main").messages;
    const toolResult = messages.find((message) => message.role === "toolResult");
    assert.match(toolResult?.text ?? "", /blocked by contract policy/);
    assert.ok(messages.every((message) => !message.text.includes("[tool:")));
  });

  test("aborts a streaming response and returns to idle", async () => {
    const { adapter, faux, root } = await fixture({ tokensPerSecond: 30 });
    faux.setResponses([fauxAssistantMessage("x".repeat(2_000))]);
    await adapter.create(spec(root));
    const started = new Promise<void>((resolve) => {
      adapter.subscribe("main", (event) => {
        if (event.type === "message.delta") resolve();
      });
    });

    await adapter.prompt("main", "stream slowly");
    await started;
    await adapter.abort("main", "contract test");
    await adapter.waitForIdle("main");

    assert.equal(adapter.snapshot("main").status, "idle");
  });

  test("preserves Pi steer and follow-up ordering while streaming", async () => {
    const { adapter, faux, root } = await fixture({ tokensPerSecond: 120 });
    faux.setResponses([
      fauxAssistantMessage(`first:${"x".repeat(240)}`),
      fauxAssistantMessage("after-steer"),
      fauxAssistantMessage("after-follow-up"),
    ]);
    await adapter.create(spec(root));
    const firstDelta = new Promise<void>((resolve) => {
      adapter.subscribe("main", (event) => {
        if (event.type === "message.delta") resolve();
      });
    });

    await adapter.prompt("main", "start");
    await firstDelta;
    await adapter.steer("main", "steering-message");
    await adapter.followUp("main", "follow-up-message");
    await adapter.waitForIdle("main");

    const messages = adapter.snapshot("main").messages;
    assert.equal(faux.state.callCount, 3);
    assert.ok(messages.some((message) => message.text === "steering-message"));
    assert.ok(messages.some((message) => message.text === "follow-up-message"));
    assert.equal(messages.at(-1)?.text, "after-follow-up");
  });

  test("promotes one queued follow-up for direct delivery without duplicating it", async () => {
    const { adapter, faux, root } = await fixture({ tokensPerSecond: 120 });
    faux.setResponses([
      fauxAssistantMessage(`first:${"x".repeat(240)}`),
      fauxAssistantMessage("after-promoted"),
      fauxAssistantMessage("after-waiting"),
    ]);
    await adapter.create(spec(root));
    const firstDelta = new Promise<void>((resolve) => {
      adapter.subscribe("main", (event) => {
        if (event.type === "message.delta") resolve();
      });
    });

    await adapter.prompt("main", "start");
    await firstDelta;
    await adapter.followUp("main", "continue waiting");
    await adapter.followUp("main", "send this now");
    await adapter.promoteFollowUp("main", 1);
    assert.deepEqual(adapter.snapshot("main").queue, {
      steering: ["send this now"],
      followUp: ["continue waiting"],
    });
    await adapter.waitForIdle("main");

    const userMessages = adapter.snapshot("main").messages
      .filter((message) => message.role === "user")
      .map((message) => message.text);
    assert.deepEqual(userMessages, ["start", "send this now", "continue waiting"]);
  });

  test("maps manual compaction lifecycle", async () => {
    const { adapter, faux, root } = await fixture({ tokenSize: { min: 1_000, max: 1_000 } });
    const longResponse = "content to compact ".repeat(1_600);
    faux.setResponses([
      fauxAssistantMessage(longResponse),
      fauxAssistantMessage(longResponse),
      fauxAssistantMessage(longResponse),
      fauxAssistantMessage(longResponse),
      ...Array.from({ length: 8 }, (_, index) => fauxAssistantMessage(`compact summary ${index}`)),
    ]);
    await adapter.create(spec(root));
    const events: RuntimeEvent[] = [];
    adapter.subscribe("main", (event) => events.push(event));
    for (let turn = 0; turn < 4; turn++) {
      await adapter.prompt("main", `create history ${turn}: ${"u".repeat(2_000)}`);
      await adapter.waitForIdle("main");
    }

    await adapter.compact("main", "Keep the contract-test fact.");

    assert.ok(events.some((event) => event.type === "compaction.started"));
    assert.ok(events.some((event) => event.type === "compaction.completed"));
  });

  test("reloads trusted skill paths only at a session boundary and keeps full instructions out of the prompt", async () => {
    let skillPaths: string[] = [];
    const readTool = defineTool({
      name: "read",
      label: "Read",
      description: "Read a file for the skill progressive-disclosure contract.",
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => ({ content: [{ type: "text" as const, text: "unused" }], details: {} }),
    });
    const { adapter, faux, root } = await fixture({
      createTools: () => [readTool],
      createSkillPaths: () => skillPaths,
    });
    const prompts: string[] = [];
    faux.setResponses([
      (context) => {
        prompts.push(context.systemPrompt ?? "");
        return fauxAssistantMessage("before skill install");
      },
      (context) => {
        prompts.push(context.systemPrompt ?? "");
        return fauxAssistantMessage("after skill install");
      },
    ]);
    await adapter.create(spec(root));
    await adapter.prompt("main", "before");
    await adapter.waitForIdle("main");

    const skill = join(root, "trusted-skill");
    await mkdir(skill);
    await writeFile(join(skill, "SKILL.md"), [
      "---",
      "name: trusted-review",
      "description: Reviews code only when a review task matches.",
      "---",
      "",
      "FULL_SKILL_BODY_SENTINEL must only be read on demand.",
      "",
    ].join("\n"));
    skillPaths = [skill];
    await adapter.newSession("main");
    await adapter.prompt("main", "after");
    await adapter.waitForIdle("main");

    assert.doesNotMatch(prompts[0] ?? "", /trusted-review/);
    assert.match(prompts[1] ?? "", /<name>trusted-review<\/name>/);
    assert.match(prompts[1] ?? "", /Reviews code only when a review task matches/);
    assert.match(prompts[1] ?? "", /SKILL\.md/);
    assert.doesNotMatch(prompts[1] ?? "", /FULL_SKILL_BODY_SENTINEL/);
  });
});
