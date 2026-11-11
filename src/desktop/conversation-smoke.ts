import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { RuntimeMessage } from "../domain/runtime.js";
import { createDesktopSmokeState } from "./smoke-fixture.js";
import { DESKTOP_FRAME_CHANNEL, type DesktopBootstrap } from "./ipc-contract.js";

/** Real renderer exercise: snapshots follow a multi-tool turn through completion. */
export async function exerciseConversation(target: BrowserWindow, base: DesktopBootstrap, output: string): Promise<void> {
  const longPath = `/project/${"很长的项目目录-".repeat(30)}package.json`;
  const longCommand = `npm test -- conversation-regression --reporter=${"long-report-name-".repeat(30)}`;
  const messages: RuntimeMessage[] = [
    { role: "user", text: "检查项目配置并运行测试。" },
    {
      role: "assistant", text: "先查看项目入口。", thinking: "核对配置后再执行针对性测试。",
      toolCalls: [{ id: "conversation-read", name: "read", input: JSON.stringify({ path: longPath }, null, 2) }],
    },
    { role: "toolResult", text: '{"scripts":{"test":"tsx --test"}}', toolCallId: "conversation-read", toolName: "read" },
    {
      role: "assistant", text: "继续验证工具调用。", thinking: "确认失败信息也会保留。",
      toolCalls: [{ id: "conversation-shell", name: "shell", input: JSON.stringify({ command: longCommand, cwd: "/project" }, null, 2) }],
    },
  ];
  const publish = (running: boolean): void => {
    const state = createDesktopSmokeState(base.snapshot, false);
    const main = state.sessions["main"];
    if (!main) throw new Error("Missing smoke session");
    state.sessions = { ...state.sessions, main: { ...main, context: { tokens: 16_000, window: 200_000, estimated: true, triggerTokens: 100_000 }, usage: { ...main.usage, total: 280_000 }, messages: [...messages], messageOffset: 0, messageCount: messages.length, status: running ? "running" : "idle", queue: { steering: [], followUp: [] } } };
    state.approvals = {};
    target.webContents.send(DESKTOP_FRAME_CHANNEL, { version: 1, kind: "snapshot", snapshot: state, cursors: base.cursors });
  };
  const wait = async (condition: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await target.webContents.executeJavaScript(condition)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Conversation smoke failed: ${condition}`);
  };
  const capture = async (name: string): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(join(output, `desktop-process-${name}-1920x1080.png`), (await target.webContents.capturePage()).toPNG());
  };
  target.setContentSize(1_920, 1_080);
  await target.webContents.executeJavaScript(`(() => {
    document.querySelector('#session-search-close')?.click();
    document.querySelector('#article-close')?.click();
    document.querySelector('#approval-overlay')?.setAttribute('hidden', '');
    document.querySelector('#app-shell')?.removeAttribute('inert');
  })()`);
  publish(true);
  await wait(`document.querySelector('.process-details')?.open === true && document.querySelectorAll('.tool-call').length === 2`);
  await wait(`document.querySelector('.tool-call:last-child .tool-call-input')?.textContent.includes('conversation-regression')`);
  await capture("running");
  messages.push(
    { role: "toolResult", text: "测试失败：fixture assertion", toolCallId: "conversation-shell", toolName: "shell", isError: true },
    { role: "assistant", text: "检查结束：已定位测试失败原因。", thinking: "整理结果并给出下一步。" },
  );
  publish(false);
  await wait(`document.querySelector('.process-details')?.open === false && document.querySelector('#transcript')?.textContent.includes('检查结束')`);
  await wait(`document.querySelectorAll('.process-body .tool-call').length === 0`);
  await capture("collapsed");
  await wait(`document.querySelector('#usage-value')?.textContent === '≈16k' && document.querySelector('#total-usage-value')?.textContent === '280k'`);
  await target.webContents.executeJavaScript(`document.querySelector('.process-summary')?.click()`);
  await wait(`document.querySelectorAll('.tool-call').length === 2`);
  await target.webContents.executeJavaScript(`document.querySelector('.tool-call summary')?.click()`);
  await wait(`document.querySelector('.tool-call details')?.open === true`);
  publish(false);
  await wait(`document.querySelector('.process-details')?.open === true && document.querySelector('.tool-call details')?.open === true`);
  await wait(`document.querySelector('.tool-call-status.error')?.textContent === '失败'`);
  await wait(`Array.from(document.querySelectorAll('.tool-call')).every(card => {
    const summary = card.querySelector('summary').getBoundingClientRect();
    const name = card.querySelector('.tool-call-name').getBoundingClientRect();
    const target = card.querySelector('.tool-call-target').getBoundingClientRect();
    const status = card.querySelector('.tool-call-status').getBoundingClientRect();
    const input = card.querySelector('.tool-call-input');
    return name.right <= target.left && target.right <= status.left && status.right <= summary.right
      && input.scrollWidth <= input.clientWidth && card.scrollWidth <= card.clientWidth;
  })`);
  // Reasoning, a step's own words and tool cards keep a visible gap; the
  // reasoning box used to sit directly on the label of the reply below it.
  await wait(`(() => {
    const steps = Array.from(document.querySelector('.process-body')?.children ?? []).filter((node) => node.getClientRects().length > 0);
    const thoughts = Array.from(document.querySelectorAll('.process-body .settled-thinking'));
    return steps.length >= 4 && thoughts.length >= 2
      && steps.every((node, index) => index === 0 || node.getBoundingClientRect().top - steps[index - 1].getBoundingClientRect().bottom >= 8)
      && thoughts.every((box) => !box.nextElementSibling || box.nextElementSibling.getBoundingClientRect().top - box.getBoundingClientRect().bottom >= 8);
  })()`);
  // A title that fits is shown whole rather than cut to a fraction of itself.
  await wait(`(() => {
    const title = document.querySelector('#session-title');
    return Boolean(title?.textContent) && title.scrollWidth <= title.clientWidth;
  })()`);
  await capture("expanded");
  await target.webContents.executeJavaScript(`(() => {
    document.querySelector('.process-summary')?.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    const input = document.querySelector('#session-search-input');
    input.value = 'conversation-regression';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(`(() => {
    const mark = document.querySelector('mark.session-find-hit.current');
    return Boolean(mark && mark.closest('.process-details')?.open && mark.closest('.tool-call details')?.open && mark.getBoundingClientRect().height > 0);
  })()`);
  await wait(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('#transcript').scrollWidth <= document.querySelector('#transcript').clientWidth`);
  await capture("search");
  await target.webContents.executeJavaScript(`document.querySelector('#session-search-close')?.click()`);
  await writeFile(join(output, "desktop-process.json"), JSON.stringify({ viewport: [1920, 1080], activeExpanded: true, completedCollapsed: true, lazyBody: true, disclosureRetained: true, failureVisible: true, inputSearch: true, longInputsContained: true, summaryLabelsSeparated: true, stepsSpaced: true, titleWhole: true, overflow: false }, null, 2));
}
