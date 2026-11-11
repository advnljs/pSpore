/**
 * The demonstration behind the README pictures: a scripted, local
 * OpenAI-compatible model and the files it reads. Shared by the desktop
 * (readme-screenshots.mjs) and terminal (readme-tui-screenshot.mjs) captures,
 * so both show the same run. No credentials, network or personal files.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * One demonstration per interface language: the files the run reads, the
 * request, and the scripted model's three turns (chosen by how many replies it
 * has already given). `streamingText` is in the part of the answer already
 * shown when the still-streaming dark picture is taken.
 */
export const DEMOS = {
  en: {
    prompt: "Read this week's work log in notes and plan next week's priorities.",
    notes: {
      "this-week.md": [
        "# This week",
        "",
        "- [x] First draft of the new proposal",
        "- [x] Two requirements reviews",
        "- [ ] Collect user feedback and finish the proposal review",
        "- [ ] File the meeting notes and project documents",
        "- [ ] Write the weekly report and confirm next week's plan",
        "",
      ].join("\n"),
      "review-tuesday.md": "# Review (Tuesday)\n\n- Feedback centres on the import flow\n- Revised plan due Monday\n",
      "review-thursday.md": "# Review (Thursday)\n\n- Delivery cadence agreed\n- Documents go to the shared folder\n",
    },
    turns: [
      {
        reasoning: "Start with this week's log to see which items are still open.",
        tool: { name: "read", arguments: { path: "notes/this-week.md" } },
      },
      {
        reasoning: "The log mentions two reviews; check that both sets of notes were written up.",
        tool: { name: "shell", arguments: { command: "wc -l notes/*.md" } },
      },
      {
        reasoning: "Of the three open items, the proposal review depends on the feedback, so it goes first.",
        text: [
          "## Next week's plan\n\n",
          "This week's log still has **3 open items**. Finish the proposal review first, then file the documents.\n\n",
          "| Priority | Task | When |\n| --- | --- | --- |\n",
          "| High | Collect user feedback and finish the proposal review | Mon–Tue |\n",
          "| Medium | File the notes from both reviews and the project documents | Wed |\n",
          "| Medium | Write the weekly report and confirm next week's plan | Fri |\n\n",
          "### Suggested next steps\n\n",
          "- [ ] Confirm an owner and a due date for each task\n",
          "- [ ] Break the proposal review into concrete steps\n",
          "- [ ] Schedule a Friday job that summarizes progress\n\n",
          "Want me to draft the weekly report next?",
        ],
        pauseAfter: 5,
      },
    ],
    streamingText: "File the notes from both reviews",
  },
  "zh-CN": {
    prompt: "请阅读 notes 里本周的工作记录，整理下周的重点任务和行动计划。",
    notes: {
      "本周工作记录.md": [
        "# 本周工作记录",
        "",
        "- [x] 完成新版方案初稿",
        "- [x] 召开两次需求评审会",
        "- [ ] 汇总用户反馈，完成方案评审",
        "- [ ] 整理会议纪要与项目资料",
        "- [ ] 编写周报并确认下周计划",
        "",
      ].join("\n"),
      "会议纪要-周二.md": "# 需求评审（周二）\n\n- 反馈集中在导入流程\n- 下周一前给出修改方案\n",
      "会议纪要-周四.md": "# 需求评审（周四）\n\n- 确认交付节奏\n- 资料统一归档到共享目录\n",
    },
    turns: [
      {
        reasoning: "先读本周的工作记录，弄清楚哪些事项还没有完成。",
        tool: { name: "read", arguments: { path: "notes/本周工作记录.md" } },
      },
      {
        reasoning: "记录里提到两次评审会，再确认会议纪要是否都已经整理出来。",
        tool: { name: "shell", arguments: { command: "wc -l notes/*.md" } },
      },
      {
        reasoning: "三项未完成的任务里，方案评审依赖反馈汇总，应该排在最前面。",
        text: [
          "## 下周行动计划\n\n",
          "本周记录里还有 **3 项**未完成事项。建议先完成方案评审，再推进资料归档。\n\n",
          "| 优先级 | 任务 | 时间安排 |\n| --- | --- | --- |\n",
          "| 高 | 汇总用户反馈并完成方案评审 | 周一至周二 |\n",
          "| 中 | 整理两次评审的会议纪要与项目资料 | 周三 |\n",
          "| 中 | 编写周报并确认下周计划 | 周五 |\n\n",
          "### 建议的下一步\n\n",
          "- [ ] 核对每项任务的负责人和交付时间\n",
          "- [ ] 把方案评审拆成可执行的步骤\n",
          "- [ ] 设置每周五自动汇总进度的定时任务\n\n",
          "需要的话，我可以继续帮你起草周报。",
        ],
        pauseAfter: 5,
      },
    ],
    streamingText: "整理两次评审",
  },
};
/**
 * Points a fresh pSpore home at the demonstration model and writes the notes
 * it reads. Returns the home's paths.
 */
export async function configureDemoHome(home, demo, modelPort, { initializePsporeHome, LlmSettingsService }) {
  const { paths } = await initializePsporeHome(home);
  await new LlmSettingsService(home, paths).save({
    provider: "custom-openai", model: "demo", customModel: true, api: "openai-completions",
    baseUrl: `http://127.0.0.1:${modelPort}/v1`, thinking: "off", permissionMode: "ask_risky",
    apiKey: "local-demo-placeholder", clearApiKey: false, clearCookie: false,
  });
  await mkdir(join(paths.workspace, "notes"), { recursive: true });
  for (const [name, text] of Object.entries(demo.notes)) await writeFile(join(paths.workspace, "notes", name), text);
  return paths;
}

/**
 * OpenAI-compatible streaming endpoint that plays the turns in order. The final
 * answer pauses at `pauseAfter` until `answerGate` resolves; `finished` resolves
 * once a final answer has been sent completely.
 */
export async function demoModel(turns, answerGate = Promise.resolve()) {
  let markFinished;
  const finished = new Promise((done) => { markFinished = done; });
  const errors = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const messages = JSON.parse(body).messages ?? [];
      const turn = turns[Math.min(messages.filter((message) => message.role === "assistant").length, turns.length - 1)];
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      for (const piece of chunked(turn.reasoning, 6)) {
        send(response, { reasoning_content: piece });
        await sleep(40);
      }
      if (turn.tool) {
        send(response, { tool_calls: [{ index: 0, id: `call-${turn.tool.name}`, type: "function",
          function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.arguments) } }] });
        finish(response, "tool_calls");
        return;
      }
      for (const [index, piece] of turn.text.entries()) {
        if (index === turn.pauseAfter) await answerGate;
        send(response, { content: piece });
        await sleep(60);
      }
      finish(response, "stop");
      markFinished();
    })().catch((error) => {
      errors.push(error);
      response.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    errors,
    finished,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function send(response, delta, finishReason = null) {
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-demo", object: "chat.completion.chunk", created: 0, model: "demo",
    choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}

function finish(response, reason) {
  send(response, {}, reason);
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-demo", object: "chat.completion.chunk", created: 0, model: "demo",
    choices: [], usage: { prompt_tokens: 3_180, completion_tokens: 420, total_tokens: 3_600 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function chunked(text, size) {
  const characters = [...text];
  return Array.from({ length: Math.ceil(characters.length / size) }, (_, index) => characters.slice(index * size, (index + 1) * size).join(""));
}

export function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

export function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}
