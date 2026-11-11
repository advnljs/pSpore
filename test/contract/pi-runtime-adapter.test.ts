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

import { validateEventEnvelope } from "../../src/desktop/validation.js";
import type { RuntimeEvent, ToolGate } from "../../src/domain/runtime.js";
import type { SessionSkill } from "../../src/plugins/types.js";
import { PiRuntimeAdapter } from "../../src/pi/pi-runtime-adapter.js";
import { toEventEnvelope } from "../../src/protocol/schema.js";
import type { AutoCompactionConfig } from "../../src/settings/compaction-settings.js";

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
    createSkills?: () => readonly SessionSkill[] | Promise<readonly SessionSkill[]>;
    autoCompaction?: AutoCompactionConfig;
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
    ...(options.createSkills ? { createSkills: options.createSkills } : {}),
    ...(options.autoCompaction ? { autoCompaction: options.autoCompaction } : {}),
  });
  cleanups.push(async () => {
    await adapter.disposeAll();
    await rm(root, { recursive: true, force: true });
  });
  return { adapter, faux, root, modelRuntime };
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
    assert.equal(adapter.branch("restored").at(-1)?.text, "continued after repair");
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
    assert.ok(events.some((event) => event.type === "transcript.delta"));
    assert.ok(events.some((event) => event.type === "transcript.item.finished"));
    assert.equal(events.filter((event) => event.type === "run.settled").length, 2);
    assert.ok(events.every((event) => !("agent" in event.payload)));

    const snapshot = adapter.snapshot("main");
    assert.equal(snapshot.status, "idle");
    assert.equal(adapter.branch("main").at(-1)?.text, "second turn");
    assert.ok(snapshot.usage.cacheWrite > 0);
    assert.ok(snapshot.usage.cacheRead > 0);
  });

  test("every event it emits survives the frame validator the desktop applies", async () => {
    const echo = defineTool({
      name: "echo_contract_tool",
      label: "Echo",
      description: "Returns what it is given.",
      parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
      execute: async (_toolCallId, params) => ({ content: [{ type: "text", text: params.value }], details: undefined }),
    });
    const { adapter, faux, root } = await fixture({ createTools: () => [echo] });
    faux.setResponses([
      // A turn whose only content is the call: Pi still opens an item for it,
      // and an item the desktop rejects costs the whole connection, not the event.
      fauxAssistantMessage(fauxToolCall("echo_contract_tool", { value: "contract" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await adapter.create({ ...spec(root), enabledTools: ["echo_contract_tool"] });
    const events: RuntimeEvent[] = [];
    adapter.subscribe("main", (event) => events.push(event));

    await adapter.prompt("main", "call the tool");
    await adapter.waitForIdle("main");

    assert.ok(events.some((event) => event.type === "transcript.item.started"));
    assert.ok(events.some((event) => event.type === "tool.completed"));
    const history = adapter.transcript("main", { from: 0, limit: 100 }).messages;
    const call = history.flatMap((message) => message.toolCalls ?? [])[0];
    assert.ok(call);
    assert.equal(call.name, "echo_contract_tool");
    assert.deepEqual(JSON.parse(call.input), { value: "contract" });
    const result = history.find((message) => message.toolCallId === call.id);
    assert.equal(result?.toolName, "echo_contract_tool");
    assert.equal(result?.text, "contract");
    assert.ok(events.some((event) => event.type === "transcript.item.finished" && Array.isArray((event.payload["item"] as Record<string, unknown>)["toolCalls"])));
    let seq = 0;
    for (const event of events) {
      // The same envelope the kernel broadcasts and the gateway puts on the wire.
      const envelope = toEventEnvelope(
        {
          id: event.id,
          ts: event.ts,
          durable: !event.transient,
          type: event.type,
          payload: {
            sessionId: event.sessionId,
            upstreamSessionId: event.upstreamSessionId,
            ...event.payload,
          },
        },
        "kernel",
        ++seq,
      );
      // The client validates what came off the wire, so the check runs on the
      // JSON round-trip rather than the in-process object.
      const onTheWire: unknown = JSON.parse(JSON.stringify(envelope));
      assert.doesNotThrow(() => validateEventEnvelope(onTheWire), `${event.type} was rejected`);
    }
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

    const deltas = (kind: string) => events
      .filter((event) => event.type === "transcript.delta" && event.payload["kind"] === kind)
      .map((event) => String(event.payload["delta"] ?? ""))
      .join("");
    const thinking = deltas("thinking");
    const text = deltas("text");
    assert.equal(thinking, "private chain of thought");
    assert.equal(text, "public final answer");
    assert.equal(adapter.branch("main").at(-1)?.text, "public final answer");
    assert.equal(adapter.branch("main").at(-1)?.thinking, "private chain of thought");
    assert.doesNotMatch(adapter.branch("main").at(-1)?.text ?? "", /private chain/);
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
    const userEntry = adapter.branch("main").find((entry) => entry.role === "user" && entry.text === "fork me");
    assert.ok(userEntry?.id);
    await adapter.fork("main", userEntry.id, "at");
    const forkedUpstreamId = adapter.snapshot("main").upstreamSessionId;
    assert.notEqual(forkedUpstreamId, newUpstreamId);
    await adapter.prompt("main", "continue fork");
    await adapter.waitForIdle("main");

    assert.equal(events.filter((event) => event.type === "session.replaced").length, 2);
    assert.ok(events.some((event) => event.upstreamSessionId === forkedUpstreamId && event.type === "transcript.delta"));
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
    const restored = adapter.branch("resumed");
    assert.ok(restored.some((message) => message.text === "remember this"));
    assert.ok(restored.some((message) => message.text === "persisted"));
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
    const messages = adapter.branch("main");
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
        if (event.type === "transcript.delta") resolve();
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
        if (event.type === "transcript.delta") resolve();
      });
    });

    await adapter.prompt("main", "start");
    await firstDelta;
    await adapter.steer("main", "steering-message");
    await adapter.followUp("main", "follow-up-message");
    await adapter.waitForIdle("main");

    const messages = adapter.branch("main");
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
        if (event.type === "transcript.delta") resolve();
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

    const userMessages = adapter.branch("main")
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

    assert.ok(events.some(
      (event) => event.type === "compaction.started" && event.payload["reason"] === "manual",
    ));
    assert.ok(events.some(
      (event) => event.type === "compaction.completed" && event.payload["reason"] === "manual",
    ));

    // Reading the persisted branch rather than the model's context is what lets
    // a client still scroll back to what compaction dropped from the context.
    const page = adapter.transcript("main", { from: 0, limit: 500 });
    assert.equal(page.from, 0);
    assert.ok(page.count >= 8, "the branch keeps the turns compaction removed from the context");
    assert.ok(page.messages.some((message) => message.text.includes("create history 0")));
    const tail = adapter.transcript("main", { limit: 2 });
    assert.equal(tail.from, page.count - 2);
    assert.equal(tail.messages.length, 2);

    // One message reads back in slices, addressed by its persisted entry id, so
    // a client can restore text the publishing ceiling had to cut.
    const long = page.messages.find((message) => message.text.includes("create history 0"));
    assert.ok(long?.id);
    const head = adapter.transcriptMessage("main", { id: long.id, limit: 16 });
    assert.equal(head.offset, 0);
    assert.equal(head.length, long.text.length);
    assert.equal(head.text, long.text.slice(0, 16));
    const rest = adapter.transcriptMessage("main", { id: long.id, offset: 16, limit: long.text.length });
    assert.equal(`${head.text}${rest.text}`, long.text);
    assert.throws(() => adapter.transcriptMessage("main", { id: "absent", limit: 4 }), /unavailable/);
  });

  test("automatically compacts at the configured direct context-token threshold", async () => {
    const { adapter, faux, root } = await fixture({
      autoCompaction: { enabled: true, triggerTokens: 1, reserveTokens: 1, keepRecentTokens: 1 },
    });
    faux.setResponses([
      fauxAssistantMessage("response above the direct threshold"),
      () => {
        assert.equal(adapter.snapshot("main").status, "running", "post-turn compaction is still part of the active task");
        return fauxAssistantMessage("automatic compact summary");
      },
    ]);
    await adapter.create(spec(root));
    const events: RuntimeEvent[] = [];
    adapter.subscribe("main", (event) => events.push(event));

    await adapter.prompt("main", "create enough context to compact");
    await adapter.waitForIdle("main");

    assert.ok(events.some(
      (event) => event.type === "compaction.started" && event.payload["reason"] === "token_threshold",
    ));
    assert.ok(events.some(
      (event) => event.type === "compaction.completed" && event.payload["reason"] === "token_threshold",
    ));
    assert.ok(faux.state.callCount >= 2);
  });

  test("pauses a tool loop for compaction before the next request, then resumes without repeating tools", async () => {
    let executions = 0;
    const tool = defineTool({
      name: "large_context_tool", label: "Large result", description: "Return a large fixture result",
      parameters: Type.Object({}),
      execute: async () => {
        executions += 1;
        return { content: [{ type: "text" as const, text: "context evidence ".repeat(20_000) }], details: undefined };
      },
    });
    const { adapter, faux, root } = await fixture({
      createTools: () => [tool],
      autoCompaction: { enabled: true, triggerTokens: 4_000, reserveTokens: 1_024, keepRecentTokens: 100 },
    });
    const events: RuntimeEvent[] = [];
    let workRequests = 0;
    const response: Parameters<typeof faux.setResponses>[0][number] = (context) => {
      if (context.systemPrompt?.includes("summar")) return fauxAssistantMessage("Summary: original task remains; large_context_tool completed once. Continue with the final answer.");
      workRequests += 1;
      if (workRequests === 1) return fauxAssistantMessage(fauxToolCall(tool.name, {}), { stopReason: "toolUse" });
      assert.ok(events.some((event) => event.type === "compaction.completed"), "must compact before continuing the tool loop");
      assert.ok(JSON.stringify(context.messages).length < 50_000, "the next model request must not contain the full oversized result");
      return fauxAssistantMessage("task complete after compaction");
    };
    faux.setResponses(Array.from({ length: 12 }, () => response));
    await adapter.create({ ...spec(root), enabledTools: [tool.name] });
    adapter.subscribe("main", (event) => events.push(event));
    await adapter.prompt("main", "run the tool once then summarize");
    await adapter.waitForIdle("main");
    assert.equal(executions, 1);
    assert.equal(workRequests, 2);
    assert.equal(adapter.branch("main").at(-1)?.text, "task complete after compaction");
    assert.equal(events.filter((event) => event.type === "run.started").length, 1);
    assert.equal(events.filter((event) => event.type === "run.settled").length, 1);
    assert.equal(adapter.snapshot("main").status, "idle");
    assert.ok(adapter.snapshot("main").context!.tokens < adapter.snapshot("main").usage.total);
    assert.ok(adapter.branch("main").every((message) => message.role !== "custom"));
    const result = adapter.branch("main").find((message) => message.role === "toolResult");
    assert.ok(result && result.text.length <= 24_000);
    assert.match(result.text, /Full output:/);
  });

  test("preserves queued and promoted messages while a tool loop is compacting", { timeout: 8_000 }, async () => {
    let releaseTool!: () => void;
    let toolStarted!: () => void;
    const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
    const started = new Promise<void>((resolve) => { toolStarted = resolve; });
    let releaseSummary!: () => void;
    let summaryStarted!: () => void;
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    const summarizing = new Promise<void>((resolve) => { summaryStarted = resolve; });
    const tool = defineTool({
      name: "queue_context_tool", label: "Queue fixture", description: "Return context after a gate", parameters: Type.Object({}),
      execute: async () => {
        toolStarted();
        await toolGate;
        return { content: [{ type: "text" as const, text: "evidence ".repeat(3_000) }], details: undefined };
      },
    });
    const { adapter, faux, root } = await fixture({ createTools: () => [tool], autoCompaction: { enabled: true, triggerTokens: 4_000, reserveTokens: 1_024, keepRecentTokens: 100 } });
    let workRequests = 0;
    const response: Parameters<typeof faux.setResponses>[0][number] = async (context) => {
      if (context.systemPrompt?.includes("summar")) {
        summaryStarted();
        await summaryGate;
        return fauxAssistantMessage("Summary: task and completed tool evidence retained.");
      }
      workRequests += 1;
      return workRequests === 1 ? fauxAssistantMessage(fauxToolCall(tool.name, {}), { stopReason: "toolUse" }) : fauxAssistantMessage("queued response complete");
    };
    faux.setResponses(Array.from({ length: 16 }, () => response));
    await adapter.create({ ...spec(root), enabledTools: [tool.name] });
    await adapter.prompt("main", "start queued task");
    await started;
    await adapter.followUp("main", "queued before compaction");
    releaseTool();
    await summarizing;
    assert.equal(adapter.snapshot("main").status, "running");
    await adapter.followUp("main", "promote during compaction");
    await adapter.promoteFollowUp("main", 1);
    assert.deepEqual(adapter.snapshot("main").queue, { steering: ["promote during compaction"], followUp: ["queued before compaction"] });
    releaseSummary();
    await adapter.waitForIdle("main");
    assert.deepEqual(adapter.branch("main").filter((message) => message.role === "user").map((message) => message.text), ["start queued task", "promote during compaction", "queued before compaction"]);
    assert.deepEqual(adapter.snapshot("main").queue, { steering: [], followUp: [] });
  });

  test("aborting an in-flight automatic compaction never resumes the original task", { timeout: 8_000 }, async () => {
    let started!: () => void;
    const summarizing = new Promise<void>((resolve) => { started = resolve; });
    const tool = defineTool({ name: "abort_context_tool", label: "Abort fixture", description: "Return context", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "evidence ".repeat(3_000) }], details: undefined }) });
    const { adapter, faux, root } = await fixture({ createTools: () => [tool], autoCompaction: { enabled: true, triggerTokens: 4_000, reserveTokens: 1_024, keepRecentTokens: 100 } });
    let workRequests = 0;
    const response: Parameters<typeof faux.setResponses>[0][number] = async (context, options) => {
      if (context.systemPrompt?.includes("summar")) {
        started();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return fauxAssistantMessage("", { stopReason: "aborted" });
      }
      workRequests += 1;
      return fauxAssistantMessage(fauxToolCall(tool.name, {}), { stopReason: "toolUse" });
    };
    faux.setResponses(Array.from({ length: 8 }, () => response));
    await adapter.create({ ...spec(root), enabledTools: [tool.name] });
    const events: RuntimeEvent[] = [];
    adapter.subscribe("main", (event) => events.push(event));
    await adapter.prompt("main", "stop during automatic summary");
    await summarizing;
    await adapter.abort("main", "user cancelled");
    await adapter.waitForIdle("main");
    assert.equal(workRequests, 1);
    assert.equal(adapter.snapshot("main").status, "idle");
    assert.equal(events.filter((event) => event.type === "runtime.error").length, 0);
    assert.equal(events.filter((event) => event.type === "run.settled").length, 1);
  });

  test("failed automatic compaction is reported and does not silently continue", { timeout: 8_000 }, async () => {
    const tool = defineTool({ name: "failed_context_tool", label: "Failure fixture", description: "Return context", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "evidence ".repeat(3_000) }], details: undefined }) });
    const { adapter, faux, root } = await fixture({ createTools: () => [tool], autoCompaction: { enabled: true, triggerTokens: 4_000, reserveTokens: 1_024, keepRecentTokens: 100 } });
    let workRequests = 0;
    const response: Parameters<typeof faux.setResponses>[0][number] = (context) => {
      if (context.systemPrompt?.includes("summar")) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture summary rejected" });
      workRequests += 1;
      return fauxAssistantMessage(fauxToolCall(tool.name, {}), { stopReason: "toolUse" });
    };
    faux.setResponses(Array.from({ length: 8 }, () => response));
    await adapter.create({ ...spec(root), enabledTools: [tool.name] });
    const events: RuntimeEvent[] = [];
    adapter.subscribe("main", (event) => events.push(event));
    await adapter.prompt("main", "report failed summary");
    await assert.rejects(adapter.waitForIdle("main"), /fixture summary rejected/);
    assert.equal(workRequests, 1);
    assert.equal(adapter.snapshot("main").status, "failed");
    assert.ok(events.some((event) => event.type === "compaction.completed" && String(event.payload["errorMessage"]).includes("fixture summary rejected")));
    assert.equal(adapter.branch("main").filter((message) => message.role === "toolResult").length, 1);
    faux.setResponses(Array.from({ length: 8 }, () => (context) => fauxAssistantMessage(context.systemPrompt?.includes("summar") ? "Recovered summary: tool already completed." : "recovered after failed summary")));
    await adapter.prompt("main", "retry after summary service recovers");
    await adapter.waitForIdle("main");
    assert.equal(adapter.snapshot("main").status, "idle");
    assert.equal(adapter.branch("main").at(-1)?.text, "recovered after failed summary");
    assert.equal(adapter.branch("main").filter((message) => message.role === "toolResult").length, 1);
  });

  test("can compact repeatedly in one logical task and honors the disabled setting", { timeout: 8_000 }, async () => {
    for (const enabled of [true, false]) {
      let executions = 0;
      const tool = defineTool({ name: "repeat_context_tool", label: "Repeated fixture", description: "Return evidence for the next step", parameters: Type.Object({}), execute: async () => {
        executions += 1;
        return { content: [{ type: "text" as const, text: `step ${executions}: ` + "evidence ".repeat(3_000) }], details: undefined };
      } });
      const { adapter, faux, root } = await fixture({ createTools: () => [tool], autoCompaction: { enabled, triggerTokens: 4_000, reserveTokens: 1_024, keepRecentTokens: 100 } });
      let summaries = 0;
      const response: Parameters<typeof faux.setResponses>[0][number] = (context) => {
        if (context.systemPrompt?.includes("summar")) {
          summaries += 1;
          return fauxAssistantMessage(`Summary: ${executions} tool steps have completed. Finish after three.`);
        }
        return executions < 3 ? fauxAssistantMessage(fauxToolCall(tool.name, {}), { stopReason: "toolUse" }) : fauxAssistantMessage("all three steps completed");
      };
      faux.setResponses(Array.from({ length: 24 }, () => response));
      await adapter.create({ ...spec(root), enabledTools: [tool.name] });
      const events: RuntimeEvent[] = [];
      adapter.subscribe("main", (event) => events.push(event));
      await adapter.prompt("main", "Complete three independent steps, exactly once each.");
      await adapter.waitForIdle("main");
      assert.equal(executions, 3);
      assert.equal(adapter.branch("main").at(-1)?.text, "all three steps completed");
      if (enabled) assert.ok(summaries >= 3);
      else assert.equal(summaries, 0);
      assert.equal(events.filter((event) => event.type === "run.started").length, 1);
      assert.equal(events.filter((event) => event.type === "run.settled").length, 1);
    }
  });

  test("counts newly returned Chinese evidence before issuing the next model request", async () => {
    const tool = defineTool({ name: "chinese_context_tool", label: "Chinese evidence", description: "Return Chinese text", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: "中文证据".repeat(3_500) }], details: undefined }) });
    const { adapter, faux, root } = await fixture({ createTools: () => [tool], autoCompaction: { enabled: true, triggerTokens: 8_000, reserveTokens: 1_024, keepRecentTokens: 100 } });
    let requests = 0;
    let summarized = false;
    const response: Parameters<typeof faux.setResponses>[0][number] = (context) => {
      if (context.systemPrompt?.includes("summar")) { summarized = true; return fauxAssistantMessage("Summary: Chinese evidence read and preserved."); }
      if (requests++ === 0) return fauxAssistantMessage(fauxToolCall(tool.name, {}), { stopReason: "toolUse" });
      assert.ok(summarized, "14k Chinese characters must not be treated as only 3.5k tokens");
      return fauxAssistantMessage("Chinese evidence processed");
    };
    faux.setResponses(Array.from({ length: 8 }, () => response));
    await adapter.create({ ...spec(root), enabledTools: [tool.name] });
    await adapter.prompt("main", "Read and summarize Chinese evidence.");
    await adapter.waitForIdle("main");
    assert.equal(adapter.branch("main").at(-1)?.text, "Chinese evidence processed");
  });

  test("processes a follow-up queued during post-answer compaction before settling", { timeout: 8_000 }, async () => {
    const { adapter, faux, root } = await fixture({ autoCompaction: { enabled: true, triggerTokens: 4_000, reserveTokens: 1_024, keepRecentTokens: 100 } });
    let releaseSummary!: () => void;
    let summaryStarted!: () => void;
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    const summarizing = new Promise<void>((resolve) => { summaryStarted = resolve; });
    let workRequests = 0;
    const response: Parameters<typeof faux.setResponses>[0][number] = async (context) => {
      if (context.systemPrompt?.includes("summar")) {
        summaryStarted();
        await summaryGate;
        return fauxAssistantMessage("Summary: the first request is complete.");
      }
      workRequests += 1;
      return fauxAssistantMessage(workRequests === 1 ? "completed evidence ".repeat(2_000) : "follow-up processed");
    };
    faux.setResponses(Array.from({ length: 10 }, () => response));
    await adapter.create(spec(root));
    const events: RuntimeEvent[] = [];
    adapter.subscribe("main", (event) => events.push(event));
    try {
      await adapter.prompt("main", "complete first request");
      await summarizing;
      await adapter.followUp("main", "queued while final answer is being compacted");
    } finally { releaseSummary(); }
    await adapter.waitForIdle("main");
    assert.equal(workRequests, 2);
    assert.equal(adapter.branch("main").at(-1)?.text, "follow-up processed");
    assert.deepEqual(adapter.snapshot("main").queue, { steering: [], followUp: [] });
    assert.equal(events.filter((event) => event.type === "run.started").length, 1);
    assert.equal(events.filter((event) => event.type === "run.settled").length, 1);
  });

  test("acknowledges and can abort pre-prompt compaction of a restored session", { timeout: 8_000 }, async () => {
    const { adapter: original, faux, root, modelRuntime } = await fixture({ autoCompaction: { enabled: false, triggerTokens: 4_000, reserveTokens: 1_024, keepRecentTokens: 100 } });
    faux.setResponses([fauxAssistantMessage("persisted evidence ".repeat(2_000))]);
    const handle = await original.create(spec(root));
    await original.prompt("main", "create long history");
    await original.waitForIdle("main");
    await original.dispose("main");
    const restored = await PiRuntimeAdapter.create({
      agentDir: join(root, "agent"), sessionRoot: join(root, "sessions"), modelRuntime,
      resolveModel: () => faux.getModel(),
      autoCompaction: { enabled: true, triggerTokens: 4_000, reserveTokens: 1_024, keepRecentTokens: 100 },
    });
    cleanups.push(async () => restored.disposeAll());
    await restored.resume({ ...spec(root), sessionFile: handle.sessionFile! });
    let releaseSummary!: () => void;
    let summaryStarted!: () => void;
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    const summarizing = new Promise<void>((resolve) => { summaryStarted = resolve; });
    faux.setResponses([async (_context, options) => {
      summaryStarted();
      options?.signal?.addEventListener("abort", releaseSummary, { once: true });
      await summaryGate;
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }]);
    const events: RuntimeEvent[] = [];
    restored.subscribe("main", (event) => events.push(event));
    const accepted = restored.prompt("main", "this request must be cancellable");
    void accepted.catch(() => undefined);
    try {
      await summarizing;
      assert.equal(await Promise.race([accepted.then(() => "accepted"), new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 200))]), "accepted");
      assert.equal(restored.snapshot("main").status, "running");
      await assert.rejects(restored.prompt("main", "overlapping prompt"), /busy/);
      await restored.abort("main", "stop before sending another model request");
      await restored.waitForIdle("main");
      assert.equal(restored.snapshot("main").status, "idle");
      assert.equal(events.filter((event) => event.type === "run.started").length, 1);
      assert.equal(events.filter((event) => event.type === "run.settled").length, 1);
      assert.equal(events.filter((event) => event.type === "runtime.error").length, 0);
      assert.equal(restored.branch("main").filter((message) => message.role === "user").length, 1);
    } finally {
      releaseSummary();
      await restored.abort("main", "test cleanup");
    }
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

  test("offers resolved workspace skills with the path-based ones, and a path-based skill keeps a contested name", async () => {
    const readTool = defineTool({
      name: "read",
      label: "Read",
      description: "Read a file for the workspace skill contract.",
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => ({ content: [{ type: "text" as const, text: "unused" }], details: {} }),
    });
    const root = await mkdtemp(join(tmpdir(), "pspore-pi-workspace-skills-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const bundled = join(root, "doc-extract");
    await mkdir(bundled);
    await writeFile(join(bundled, "SKILL.md"), "---\nname: doc-extract\ndescription: Bundled extraction wins its name.\n---\n");
    const workspace = (name: string, description: string, hidden = false): SessionSkill => ({
      name,
      description,
      filePath: join(root, "workspace", name, "SKILL.md"),
      baseDir: join(root, "workspace", name),
      disableModelInvocation: hidden,
    });
    const { adapter, faux, root: sessionRoot } = await fixture({
      createTools: () => [readTool],
      createSkillPaths: () => [bundled],
      createSkills: () => [
        workspace("ccb-mail", "发送邮件: 支持附件 & <抄送>"),
        workspace("doc-extract", "USER_COPY_SENTINEL"),
        workspace("manual-only", "MANUAL_ONLY_SENTINEL", true),
      ],
    });
    const prompts: string[] = [];
    faux.setResponses([(context) => {
      prompts.push(context.systemPrompt ?? "");
      return fauxAssistantMessage("listed skills");
    }]);
    await adapter.create(spec(sessionRoot));
    await adapter.prompt("main", "list your skills");
    await adapter.waitForIdle("main");

    const prompt = prompts[0] ?? "";
    assert.match(prompt, /<name>ccb-mail<\/name>/);
    assert.match(prompt, /发送邮件: 支持附件 &amp; &lt;抄送&gt;/);
    assert.ok(prompt.includes(join(root, "workspace", "ccb-mail", "SKILL.md")));
    assert.match(prompt, /Bundled extraction wins its name/);
    assert.doesNotMatch(prompt, /USER_COPY_SENTINEL/);
    assert.doesNotMatch(prompt, /MANUAL_ONLY_SENTINEL/);
  });
});
