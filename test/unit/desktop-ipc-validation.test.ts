import assert from "node:assert/strict";
import test from "node:test";

import { initialKernelState } from "../../src/kernel/state.js";
import {
  decodeDesktopCommand,
  decodeDesktopLlmSettingsUpdate,
  toProtocolInvocation,
  type DesktopCommand,
} from "../../src/desktop/ipc-contract.js";
import {
  assertSafeProtocolValue,
  validateEventEnvelope,
  validateKernelState,
  validateServerHello,
} from "../../src/desktop/validation.js";

test("desktop IPC decoder exposes only bounded allowlisted actions", () => {
  assert.deepEqual(decodeDesktopCommand({ action: "prompt", text: "hello" }), { action: "prompt", text: "hello" });
  assert.deepEqual(decodeDesktopCommand({ action: "approval.resolve", approvalId: "approval-1", approved: true, scope: "once" }), {
    action: "approval.resolve",
    approvalId: "approval-1",
    approved: true,
    scope: "once",
  });
  assert.deepEqual(decodeDesktopCommand({ action: "resources.inspect", stagingName: "review-helper.v1" }), {
    action: "resources.inspect",
    stagingName: "review-helper.v1",
  });
  assert.throws(() => decodeDesktopCommand({ action: "shell.exec", command: "id" }), /not allowlisted/);
  assert.throws(() => decodeDesktopCommand({ action: "abort", channel: "arbitrary" }), /unknown fields/);
  assert.throws(() => decodeDesktopCommand({ action: "resources.inspect", stagingName: "../escape" }), /top-level staging/);
  assert.throws(() => decodeDesktopCommand({ action: "agent.join", agentIds: [] }), /contain 1-32/);
  assert.throws(
    () => decodeDesktopCommand({ action: "resources.install", stagingName: "skill", expectedDigest: "ABC" }),
    /lowercase SHA-256/,
  );
});

test("desktop LLM settings decoder rejects ambiguous secrets and unsafe endpoints", () => {
  const valid = {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com/v1",
    api: "provider-default",
    thinking: "off",
    customModel: false,
    apiKey: "test-key",
    clearApiKey: false,
  } as const;
  assert.deepEqual(decodeDesktopLlmSettingsUpdate(valid), valid);
  assert.throws(
    () => decodeDesktopLlmSettingsUpdate({ ...valid, baseUrl: "https://user:pass@example.com/v1" }),
    /without credentials/,
  );
  assert.throws(
    () => decodeDesktopLlmSettingsUpdate({ ...valid, apiKey: "line\nbreak" }),
    /cannot contain line breaks/,
  );
  assert.throws(
    () => decodeDesktopLlmSettingsUpdate({ ...valid, clearApiKey: true }),
    /set and clear/,
  );
  assert.throws(
    () => decodeDesktopLlmSettingsUpdate({ ...valid, provider: "../escape" }),
    /unsupported characters/,
  );
  assert.throws(
    () => decodeDesktopLlmSettingsUpdate({ ...valid, customModel: true, api: "provider-default" }),
    /must be selected/,
  );
});

test("desktop command mapping fixes session, resource root, and child ceiling", () => {
  const paths = { stagingPath: (name: string) => `/private/workspace/staging/${name}` };
  assert.deepEqual(toProtocolInvocation({ action: "steer", text: "redirect" }, paths), {
    type: "session.prompt",
    payload: { text: "redirect", mode: "steer" },
    sessionId: "main",
  });
  assert.deepEqual(toProtocolInvocation({ action: "resources.inspect", stagingName: "safe-skill" }, paths), {
    type: "resources.inspect",
    payload: { stagingPath: "/private/workspace/staging/safe-skill" },
  });
  const spawn = toProtocolInvocation({ action: "agent.spawn", objective: "bounded work" }, paths);
  assert.equal(spawn.type, "agent.spawn");
  assert.deepEqual(spawn.payload["workspaceMode"], "shared-read");
  assert.deepEqual((spawn.payload["budget"] as Record<string, unknown>)["maxChildren"], 0);

  const commands: DesktopCommand[] = [
    { action: "jobs.list" },
    { action: "runs.list" },
    { action: "notifications.list" },
    { action: "agents.list" },
    { action: "mcp.servers" },
    { action: "mcp.tools" },
    { action: "resources.list" },
    { action: "skills.list" },
    { action: "plugins.list" },
  ];
  for (const command of commands) assert.deepEqual(toProtocolInvocation(command, paths).payload, {});
});

test("desktop validates snapshots, hello frames, event types, and JSON bounds", () => {
  const snapshot = initialKernelState();
  assert.deepEqual(validateKernelState(snapshot), snapshot);
  const hello = {
    v: 1,
    kind: "hello_ack",
    id: "hello-1",
    protocolVersion: 1,
    instanceId: "daemon-1",
    streamId: "stream-1",
    latestSeq: 0,
    replayFromSeq: 1,
    snapshot,
  };
  assert.deepEqual(validateServerHello(hello), hello);
  const event = {
    v: 1,
    kind: "event",
    id: "event-1",
    streamId: "stream-1",
    seq: 1,
    ts: "2026-08-10T00:00:00.000Z",
    durable: false,
    type: "message.delta",
    payload: { sessionId: "main", upstreamSessionId: "upstream-main", delta: "" },
  };
  assert.deepEqual(validateEventEnvelope(event), event);
  assert.throws(() => validateEventEnvelope({ ...event, type: "renderer.eval" }), /not allowlisted/);
  assert.throws(() => validateKernelState({ ...snapshot, arbitrary: true }), /unknown fields/);
  const nested: unknown[] = [];
  let cursor = nested;
  for (let index = 0; index < 40; index++) {
    const next: unknown[] = [];
    cursor.push(next);
    cursor = next;
  }
  assert.throws(() => assertSafeProtocolValue(nested), /nesting depth/);
});
