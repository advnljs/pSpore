import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDesktopSmokeState } from "./smoke-fixture.js";
import { DESKTOP_FRAME_CHANNEL } from "./ipc-contract.js";
/** Real renderer exercise: snapshots follow a multi-tool turn through completion. */
export async function exerciseConversation(target, base, output) {
    const messages = [
        { role: "user", text: "检查项目配置并运行测试。" },
        {
            role: "assistant", text: "先查看项目入口。", thinking: "核对配置后再执行针对性测试。",
            toolCalls: [{ id: "conversation-read", name: "read", input: '{\n  "path": "/project/package.json"\n}' }],
        },
        { role: "toolResult", text: '{"scripts":{"test":"tsx --test"}}', toolCallId: "conversation-read", toolName: "read" },
        {
            role: "assistant", text: "继续验证工具调用。", thinking: "确认失败信息也会保留。",
            toolCalls: [{ id: "conversation-shell", name: "shell", input: '{\n  "command": "npm test -- conversation-regression",\n  "cwd": "/project"\n}' }],
        },
    ];
    const publish = (running) => {
        const state = createDesktopSmokeState(base.snapshot, false);
        const main = state.sessions["main"];
        if (!main)
            throw new Error("Missing smoke session");
        state.sessions = { ...state.sessions, main: { ...main, messages: [...messages], messageOffset: 0, messageCount: messages.length, status: running ? "running" : "idle", queue: { steering: [], followUp: [] } } };
        state.approvals = {};
        target.webContents.send(DESKTOP_FRAME_CHANNEL, { version: 1, kind: "snapshot", snapshot: state, cursors: base.cursors });
    };
    const wait = async (condition) => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
            if (await target.webContents.executeJavaScript(condition))
                return;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`Conversation smoke failed: ${condition}`);
    };
    const capture = async (name) => {
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
    messages.push({ role: "toolResult", text: "测试失败：fixture assertion", toolCallId: "conversation-shell", toolName: "shell", isError: true }, { role: "assistant", text: "检查结束：已定位测试失败原因。", thinking: "整理结果并给出下一步。" });
    publish(false);
    await wait(`document.querySelector('.process-details')?.open === false && document.querySelector('#transcript')?.textContent.includes('检查结束')`);
    await wait(`document.querySelectorAll('.process-body .tool-call').length === 0`);
    await capture("collapsed");
    await target.webContents.executeJavaScript(`document.querySelector('.process-summary')?.click()`);
    await wait(`document.querySelectorAll('.tool-call').length === 2`);
    await target.webContents.executeJavaScript(`document.querySelector('.tool-call summary')?.click()`);
    await wait(`document.querySelector('.tool-call details')?.open === true`);
    publish(false);
    await wait(`document.querySelector('.process-details')?.open === true && document.querySelector('.tool-call details')?.open === true`);
    await wait(`document.querySelector('.tool-call-status.error')?.textContent === '失败'`);
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
    await writeFile(join(output, "desktop-process.json"), JSON.stringify({ viewport: [1920, 1080], activeExpanded: true, completedCollapsed: true, lazyBody: true, disclosureRetained: true, failureVisible: true, inputSearch: true, overflow: false }, null, 2));
}
//# sourceMappingURL=conversation-smoke.js.map