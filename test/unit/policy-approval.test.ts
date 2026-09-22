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
  test("asks before the model edits a workspace skill, but not for reading one or running a command beside it", async () => {
    const { root } = await rootFixture();
    const skill = join(root, "skills", "ccb-mail");
    await mkdir(skill, { recursive: true });
    const policy = await PolicyEngine.create({ mode: "ask_risky", rules: [], workspaceRoot: root, cwd: root });

    const edit = await policy.evaluate({
      sessionId: "s",
      toolCallId: "skill-edit",
      toolName: "edit",
      input: { path: join(skill, "SKILL.md") },
    });
    assert.equal(edit.decision, "ask");
    assert.ok(edit.riskReasons.includes("changes skill instructions that new sessions load automatically"));

    const note = await policy.evaluate({
      sessionId: "s",
      toolCallId: "note-edit",
      toolName: "edit",
      input: { path: join(root, "notes.md") },
    });
    assert.equal(note.decision, "allow");
    assert.equal(
      (await policy.evaluate({ sessionId: "s", toolCallId: "skill-read", toolName: "read", input: { path: join(skill, "SKILL.md") } })).decision,
      "allow",
    );
    assert.equal(
      (await policy.evaluate({ sessionId: "s", toolCallId: "skill-run", toolName: "shell", input: { command: "ls", cwd: skill } })).decision,
      "allow",
    );
    const article = await policy.evaluate({
      sessionId: "s",
      toolCallId: "article-1",
      toolName: "article",
      input: { action: "create", title: "周报", content: "正文" },
    });
    assert.equal(article.decision, "allow");
    assert.deepEqual(article.riskReasons, []);
    const document = await policy.evaluate({
      sessionId: "s",
      toolCallId: "doc-1",
      toolName: "document",
      input: { path: join(root, "notes.md") },
    });
    assert.equal(document.decision, "allow");
    assert.equal(document.capability, "fs.read");
  });

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
    const readonlyDiagnostics = await risky.evaluate({
      sessionId: "s",
      toolCallId: "diagnostics",
      toolName: "shell",
      input: { command: "node --version 2>/dev/null; df -h .", cwd: root },
    });
    assert.equal(readonlyDiagnostics.decision, "allow");
    const deviceWrite = await risky.evaluate({
      sessionId: "s",
      toolCallId: "device-write",
      toolName: "shell",
      input: { command: "printf data >/dev/sdb", cwd: root },
    });
    assert.equal(deviceWrite.decision, "ask");
    assert.ok(deviceWrite.riskReasons.includes("disk or device mutation"));
    assert.equal(
      (
        await risky.evaluate({
          sessionId: "s",
          toolCallId: "schedule-read",
          toolName: "schedule",
          input: { action: "list" },
        })
      ).decision,
      "allow",
    );
    const scheduleWrite = await risky.evaluate({
      sessionId: "s",
      toolCallId: "schedule-write",
      toolName: "schedule",
      input: { action: "put", job: { id: "daily" } },
    });
    assert.equal(scheduleWrite.decision, "ask");
    assert.equal(scheduleWrite.capability, "schedule.write");
    const mcpDiscover = await risky.evaluate({
      sessionId: "s",
      toolCallId: "mcp-discover",
      toolName: "mcp_discover",
      input: { serverId: "local" },
    });
    assert.equal(mcpDiscover.decision, "ask");
    assert.equal(mcpDiscover.capability, "external.side_effect");
    assert.equal(
      (
        await risky.evaluate({
          sessionId: "s",
          toolCallId: "mcp-call",
          toolName: "mcp__local__read",
          input: {},
        })
      ).decision,
      "ask",
    );

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

  test("enforces a parent agent capability ceiling even under allow_all", async () => {
    const { root, state } = await rootFixture();
    const approvals = new ApprovalService({
      pendingPath: join(state, "pending.json"),
      auditPath: join(state, "audit.jsonl"),
      timeoutMs: 2_000,
    });
    await approvals.initialize();
    const policy = await PolicyEngine.create({ mode: "allow_all", rules: [], workspaceRoot: root, cwd: root });
    const result = await new PolicyToolGate(policy, approvals).authorize({
      sessionId: "agent:read-only",
      toolCallId: "write-attempt",
      toolName: "edit",
      input: { path: join(root, "result.txt") },
      deniedCapabilities: ["fs.write"],
    });
    assert.deepEqual(result, {
      decision: "deny",
      reason: "Denied by parent agent permission ceiling",
      terminate: false,
    });
    assert.equal(approvals.list().length, 0);
    const mcpResult = await new PolicyToolGate(policy, approvals).authorize({
      sessionId: "agent:read-only",
      toolCallId: "mcp-attempt",
      toolName: "mcp_call",
      input: { serverId: "local", toolName: "read" },
      deniedCapabilities: ["external.side_effect"],
    });
    assert.equal(mcpResult.decision, "deny");
    await approvals.close();
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

  test("rejects a scope that was not offered without consuming the pending approval", async () => {
    const { root, state } = await rootFixture();
    const published: ApprovalRequest[] = [];
    const service = new ApprovalService({
      pendingPath: join(state, "pending.json"),
      auditPath: join(state, "audit.jsonl"),
      timeoutMs: 2_000,
      onRequested: (request) => published.push(request),
    });
    await service.initialize();
    const policy = await PolicyEngine.create({ mode: "ask_all", rules: [], workspaceRoot: root, cwd: root });
    const authorization = new PolicyToolGate(policy, service).authorize({
      sessionId: "main",
      toolCallId: "tool-invalid-scope",
      toolName: "shell",
      input: { command: "printf ok", cwd: root },
    });
    await waitFor(() => published.length === 1);
    const id = published[0]?.id;
    assert.ok(id);
    assert.deepEqual(published[0]?.allowedScopes, ["once", "session"]);
    assert.deepEqual(
      await service.resolve(id, { approved: true, scope: "job", actor: "test-client" }),
      { status: "invalid_scope" },
    );
    assert.equal(service.list().length, 1);
    assert.deepEqual(
      await service.resolve(id, { approved: false, scope: "once", actor: "test-client" }),
      { status: "resolved" },
    );
    const result = await authorization;
    assert.equal(result.decision, "deny");
    await service.close();
  });

  test("restores exact job grants after restart while explicit deny remains authoritative", async () => {
    const { root, state } = await rootFixture();
    const pendingPath = join(state, "pending.json");
    const auditPath = join(state, "audit.jsonl");
    const grantsPath = join(state, "job-grants.json");
    const published: ApprovalRequest[] = [];
    const service = new ApprovalService({
      pendingPath,
      auditPath,
      grantsPath,
      timeoutMs: 2_000,
      onRequested: (request) => published.push(request),
    });
    await service.initialize();
    const askPolicy = await PolicyEngine.create({ mode: "ask_all", rules: [], workspaceRoot: root, cwd: root });
    const first = new PolicyToolGate(askPolicy, service).authorize({
      sessionId: "run:one",
      toolCallId: "tool-job-grant",
      toolName: "shell",
      input: { command: "printf first", cwd: root },
      agentPath: ["automation", "daily", "run-one"],
      runId: "run-one",
      jobId: "daily",
      allowedApprovalScopes: ["once", "session", "job"],
    });
    await waitFor(() => published.length === 1);
    const request = published[0];
    assert.ok(request);
    assert.deepEqual(request.agentPath, ["automation", "daily", "run-one"]);
    assert.equal(request.runId, "run-one");
    assert.equal(request.jobId, "daily");
    assert.deepEqual(request.allowedScopes, ["once", "session", "job"]);
    assert.deepEqual(
      await service.resolve(request.id, { approved: true, scope: "job", actor: "test-client" }),
      { status: "resolved" },
    );
    assert.deepEqual(await first, { decision: "allow" });
    assert.match(await readFile(grantsPath, "utf8"), /"jobId": "daily"/);
    await service.close();

    const reasked: ApprovalRequest[] = [];
    const restarted = new ApprovalService({
      pendingPath,
      auditPath,
      grantsPath,
      timeoutMs: 2_000,
      onRequested: (approval) => reasked.push(approval),
    });
    await restarted.initialize();
    const restoredGate = new PolicyToolGate(askPolicy, restarted);
    assert.deepEqual(
      await restoredGate.authorize({
        sessionId: "run:two",
        toolCallId: "tool-restored-grant",
        toolName: "shell",
        input: { command: "printf second", cwd: root },
        jobId: "daily",
        allowedApprovalScopes: ["once", "session", "job"],
      }),
      { decision: "allow" },
    );
    assert.equal(reasked.length, 0);

    const denyPolicy = await PolicyEngine.create({
      mode: "allow_all",
      rules: [{ effect: "deny", capability: "process.exec" }],
      workspaceRoot: root,
      cwd: root,
    });
    assert.deepEqual(
      await new PolicyToolGate(denyPolicy, restarted).authorize({
        sessionId: "run:three",
        toolCallId: "tool-denied-despite-grant",
        toolName: "shell",
        input: { command: "printf third", cwd: root },
        jobId: "daily",
      }),
      { decision: "deny", reason: "Denied by pSpore policy", terminate: false },
    );
    assert.equal(reasked.length, 0);
    await restarted.close();
  });

  test("fails closed when the durable job grant store is malformed", async () => {
    const { state } = await rootFixture();
    const grantsPath = join(state, "job-grants.json");
    const { atomicWriteJson } = await import("../../src/storage/atomic.js");
    await atomicWriteJson(grantsPath, { version: 1, grants: [{ version: 1, jobId: "missing-fields" }] });
    const service = new ApprovalService({
      pendingPath: join(state, "pending.json"),
      auditPath: join(state, "audit.jsonl"),
      grantsPath,
      timeoutMs: 25,
    });
    await assert.rejects(service.initialize(), /capability is invalid/);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for predicate");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
