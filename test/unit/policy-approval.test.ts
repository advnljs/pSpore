import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { ApprovalService, PolicyToolGate, type ApprovalRequest } from "../../src/policy/approval-service.js";
import { PolicyEngine } from "../../src/policy/policy.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function rootFixture() {
  const root = await mkdtemp(join(tmpdir(), "pspore-policy-"));
  roots.push(root);
  const state = join(root, "state");
  await mkdir(state, { mode: 0o700 });
  return { root, state };
}

describe("policy", () => {
  test("asks for risky shell, allows low-risk reads, and keeps explicit deny under allow_all", async () => {
    const { root } = await rootFixture();
    const risky = await PolicyEngine.create({ mode: "ask_risky", rules: [], workspaceRoot: root, cwd: root });
    assert.equal(
      (await risky.evaluate({ sessionId: "s", toolCallId: "1", toolName: "read", input: { path: root } })).decision,
      "allow",
    );
    const sudo = await risky.evaluate({
      sessionId: "s",
      toolCallId: "2",
      toolName: "shell",
      input: { command: "sudo systemctl restart demo", cwd: root },
    });
    assert.equal(sudo.decision, "ask");
    assert.ok(sudo.riskReasons.some((reason) => reason.includes("privilege")));

    const permissive = await PolicyEngine.create({
      mode: "allow_all",
      rules: [{ effect: "deny", capability: "process.exec" }],
      workspaceRoot: root,
      cwd: root,
    });
    assert.equal(
      (
        await permissive.evaluate({
          sessionId: "s",
          toolCallId: "3",
          toolName: "shell",
          input: { command: "printf ok", cwd: root },
        })
      ).decision,
      "deny",
    );
  });
});

describe("approval", () => {
  test("persists before publish and accepts only the first resolution", async () => {
    const { root, state } = await rootFixture();
    const pendingPath = join(state, "pending.json");
    const auditPath = join(state, "audit.jsonl");
    const published: ApprovalRequest[] = [];
    const service = new ApprovalService({
      pendingPath,
      auditPath,
      timeoutMs: 2_000,
      onRequested: (request) => published.push(request),
    });
    await service.initialize();
    const policy = await PolicyEngine.create({ mode: "ask_all", rules: [], workspaceRoot: root, cwd: root });
    const gate = new PolicyToolGate(policy, service);
    const authorization = gate.authorize({
      sessionId: "main",
      toolCallId: "tool-1",
      toolName: "shell",
      input: { command: "printf ok", cwd: root },
    });
    await waitFor(() => published.length === 1);
    const persisted = await readFile(pendingPath, "utf8");
    assert.match(persisted, new RegExp(published[0]?.id ?? "missing"));

    const id = published[0]?.id;
    assert.ok(id);
    assert.deepEqual(
      await service.resolve(id, { approved: true, scope: "once", actor: "test-client-a" }),
      { status: "resolved" },
    );
    assert.deepEqual(
      await service.resolve(id, { approved: false, scope: "once", actor: "test-client-b" }),
      { status: "already_resolved" },
    );
    assert.deepEqual(await authorization, { decision: "allow" });
    assert.equal(service.list().length, 0);
    await service.close();
  });

  test("fails closed on timeout and invalidates recovered approvals", async () => {
    const { root, state } = await rootFixture();
    const pendingPath = join(state, "pending.json");
    const auditPath = join(state, "audit.jsonl");
    const service = new ApprovalService({ pendingPath, auditPath, timeoutMs: 25 });
    await service.initialize();
    const policy = await PolicyEngine.create({ mode: "ask_all", rules: [], workspaceRoot: root, cwd: root });
    const gate = new PolicyToolGate(policy, service);
    const result = await gate.authorize({
      sessionId: "main",
      toolCallId: "tool-timeout",
      toolName: "shell",
      input: { command: "printf ok", cwd: root },
    });
    assert.equal(result.decision, "deny");
    assert.match(result.decision === "deny" ? result.reason : "", /approval-timeout/);

    const recovered: ApprovalRequest = {
      id: "old",
      sessionId: "main",
      agentPath: ["main"],
      toolCallId: "old-tool",
      capability: "process.exec",
      display: { summary: "old request" },
      riskReasons: [],
      requestedAt: new Date(0).toISOString(),
      expiresAt: new Date(1).toISOString(),
      allowedScopes: ["once"],
    };
    const { atomicWriteJson } = await import("../../src/storage/atomic.js");
    await atomicWriteJson(pendingPath, { version: 1, approvals: [recovered] });
    const restarted = new ApprovalService({ pendingPath, auditPath, timeoutMs: 25 });
    await restarted.initialize();
    assert.equal(restarted.list().length, 0);
    assert.match(await readFile(auditPath, "utf8"), /interrupted/);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for predicate");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
