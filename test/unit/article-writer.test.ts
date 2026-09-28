import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";

import { articleWritingReference, isArticleCompletionReceipt } from "../../src/articles/writer-context.js";

const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant", content, api: "openai-completions", provider: "custom-openai", model: "test",
  usage, stopReason: "stop", timestamp: 0,
});
const result = (toolCallId: string, toolName: string, text: string): Message => ({
  role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 0,
});

test("writer quotes choices and research without article workflow instructions, receipts or pending calls", () => {
  const messages: Message[] = [
    { role: "user", content: "帮我写一个科幻开篇", timestamp: 0 },
    assistant([{ type: "toolCall", id: "skill", name: "read", arguments: { path: "/workspace/skills/article-canvas/SKILL.md" } }]),
    result("skill", "read", "聊天里只用一两句话，不要把正文粘贴进聊天。调用 article。"),
    assistant([{ type: "text", text: "1. 赛博朋克；2. 太空歌剧" }]),
    { role: "user", content: "1", timestamp: 0 },
    assistant([{ type: "toolCall", id: "research", name: "read", arguments: { path: "/workspace/setting.md" } }]),
    result("research", "read", "世界观资料：义体可以移植记忆。"),
    assistant([{ type: "toolCall", id: "open", name: "article", arguments: { action: "open", title: "灰域" } }]),
    result("open", "article", "article open\n面板已打开，请下一轮调用 write。"),
    assistant([{ type: "toolCall", id: "read-article", name: "article", arguments: { action: "read", id: "art_0123456789ab" } }]),
    result("read-article", "article", "article art_0123456789ab version 1\n标题：资料\n只用于继续修改，不要复制到聊天回复。\n\n此前的情节：记忆失踪。"),
    { role: "user", content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }], timestamp: 0 },
    assistant([{ type: "toolCall", id: "pending", name: "article", arguments: { action: "write", instruction: "当前指令" } }]),
  ];
  const reference = articleWritingReference(messages, "pending");
  assert.equal(reference?.role, "user");
  const text = JSON.stringify(reference);
  assert.match(text, /科幻开篇/);
  assert.match(text, /赛博朋克/);
  assert.match(text, /义体可以移植记忆/);
  assert.match(text, /此前的情节/);
  assert.match(text, /aW1hZ2U=/);
  assert.doesNotMatch(text, /只用一两句|不要复制|下一轮调用|当前指令|toolCall|toolResult/);
  assert.equal(articleWritingReference([assistant([])], "missing"), undefined);
});

test("receipt guard catches panel hand-offs without rejecting short poems or quoted dialogue", () => {
  for (const text of [
    "开篇写好了，面板里可以看到全文。今天先收工，明天继续写第二章。",
    "# 灰域接线员\n\n开篇已写好，请在右侧面板查看全文。",
    "The story is ready. You can read it in the article panel.",
    "I've written the report. See the canvas for the full text.",
  ]) assert.equal(isArticleCompletionReceipt(text), true, text);
  for (const text of [
    "霓虹落雨，记忆归零。",
    "# 雨\n\n灯灭了。\n\n雨还在下。",
    "她说：‘开篇写好了，面板里可以看到全文。’随后关掉终端。",
    "# 控制面板说明\n\n在面板中查看全文，然后单击导出。",
    "The panel glowed. A memory flickered, then vanished.",
  ]) assert.equal(isArticleCompletionReceipt(text), false, text);
});
