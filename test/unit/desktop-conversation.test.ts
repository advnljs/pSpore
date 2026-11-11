import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationRows, conversationRowText, toolCallSummary } from "../../src/desktop/renderer/conversation.js";
import type { RuntimeMessage } from "../../src/domain/runtime.js";
import { toolInputText } from "../../src/ui/shared/activity.js";

const work: RuntimeMessage[] = [
  { role: "user", text: "检查项目" },
  { role: "assistant", text: "先检查配置。", thinking: "需要定位入口", toolCalls: [{ id: "read-1", name: "read", input: '{"path":"/project/package.json"}' }] },
  { role: "toolResult", text: "配置内容", toolCallId: "read-1", toolName: "read" },
  { role: "assistant", text: "运行验证。", thinking: "接着测试", toolCalls: [{ id: "shell-1", name: "shell", input: '{"command":"npm test"}' }] },
  { role: "toolResult", text: "PASS", toolCallId: "shell-1", toolName: "shell" },
];

test("a multi-step run stays open until the final reply and keeps that reply separate", () => {
  const active = conversationRows(work, 100, true);
  assert.equal(active.length, 2);
  assert.equal(active[1]?.kind, "process");
  assert.ok(active[1]?.kind === "process" && active[1].active);
  const done = conversationRows([...work, { role: "assistant", text: "检查完成", thinking: "整理结论" }], 100, true);
  assert.equal(done.length, 3);
  const process = done[1];
  assert.ok(process?.kind === "process");
  assert.equal(process.active, false);
  assert.equal(process.key, active[1]?.key);
  assert.equal(process.entries.length, 5);
  const text = conversationRowText(process);
  for (const value of ["需要定位入口", "/project/package.json", "接着测试", "npm test", "PASS", "整理结论"]) assert.ok(text.includes(value));
  assert.equal(text.split("PASS").length, 2);
  assert.equal(conversationRowText(done[2]!), "检查完成");
});

test("stopping, history backfill and user boundaries do not merge unrelated work", () => {
  const stopped = conversationRows(work, 100, false);
  assert.ok(stopped[1]?.kind === "process" && !stopped[1].active);
  const extra = conversationRows([...work, { role: "user", text: "新任务" }, ...work.slice(1)], 0, true);
  assert.deepEqual(extra.map((row) => row.kind), ["message", "process", "message", "process"]);
  const partial = conversationRows(work.slice(2), 102, false);
  assert.ok(conversationRowText(partial[0]!).includes("配置内容"));
  const backfill = conversationRows([{ role: "assistant", text: "之前的答复" }, ...work], 99, false);
  assert.equal(backfill.at(-1)?.key, stopped.at(-1)?.key);
});

test("legacy tool results, thinking-only messages and empty messages remain usable", () => {
  const rows = conversationRows([
    { role: "assistant", text: "旧格式过程" },
    { role: "tool", text: "旧结果" },
    { role: "assistant", text: "" },
    { role: "assistant", text: "", thinking: "最后检查" },
  ], 0, false);
  assert.equal(rows.length, 1);
  assert.match(conversationRowText(rows[0]!), /旧格式过程\n旧结果\n最后检查/);
});

test("tool summaries prefer meaningful input and handle invalid or long JSON", () => {
  const summary = (input: string): string => toolCallSummary({ id: "a", name: "shell", input });
  assert.equal(summary('{"command":"npm test","timeout":60}'), "npm test");
  assert.equal(summary('{"path":"/some/file","offset":0}'), "/some/file");
  assert.equal(summary("{}"), "无参数");
  assert.equal(summary("partial\n JSON"), "partial JSON");
  assert.equal(summary("x".repeat(500)).length, 160);
});

test("displayed tool inputs retain parameters and reuse credential redaction", () => {
  const text = toolInputText({ command: "npm test", arguments: { apiKey: "fixture-private-value", path: "/project" }, token: "fixture-token" });
  assert.match(text, /npm test/);
  assert.match(text, /\/project/);
  assert.doesNotMatch(text, /fixture-private-value|fixture-token/);
  assert.equal(JSON.parse(text).arguments.apiKey, "[redacted]");
});
