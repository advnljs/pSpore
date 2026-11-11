import { Input, decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, } from "@earendil-works/pi-tui";
import { formatDuration } from "../shared/activity.js";
import { formatTokens, kernelMetrics, presentSessions, shortId } from "../shared/presentation.js";
export class PsporeTuiView {
    focused = false;
    #options;
    #input = new Input();
    #question;
    #secretValue = "";
    #scrollOffset = 0;
    #animationTimer;
    constructor(options) {
        this.#options = options;
        this.#input.onSubmit = (value) => {
            if (this.#question) {
                this.#finishQuestion(value);
                return;
            }
            const input = value.trim();
            if (!input)
                return;
            this.#input.setValue("");
            this.#scrollOffset = 0;
            options.onSubmit(input);
            options.requestRender();
        };
        this.#input.onEscape = () => {
            if (this.#question)
                this.#finishQuestion(undefined);
            else
                options.onBack();
            options.requestRender();
        };
    }
    render(width) {
        const state = this.#options.state();
        this.#syncAnimation(hasMotion(state));
        this.#input.focused = this.focused;
        const input = this.#question?.secret
            ? maskSecretInput(this.#secretValue, Math.max(1, width - 22))
            : this.#input.render(Math.max(1, width - 22))[0] ?? "";
        return renderTuiSnapshot(state, width, this.#options.height(), input, {
            scrollOffset: this.#scrollOffset,
            // Broadcasts carry only the newest messages, so the page before them is
            // requested when the reader scrolls past everything already loaded —
            // not on every PageUp, which would pull in history nobody is reading.
            onHistoryExhausted: () => this.#options.onScrollBack?.(),
            color: process.env["NO_COLOR"] === undefined && process.env["TERM"] !== "dumb",
            animationFrame: Math.floor(Date.now() / 120),
            ...(this.#question ? { promptLabel: this.#question.label, secretInput: this.#question.secret } : {}),
        });
    }
    handleInput(data) {
        if (this.#question?.secret) {
            this.#handleSecretInput(data);
            this.#options.requestRender();
            return;
        }
        if (matchesKey(data, "ctrl+c")) {
            if (this.#question)
                this.#finishQuestion(undefined);
            else
                this.#options.onInterrupt();
            return;
        }
        if (!this.#question && matchesKey(data, "pageUp")) {
            this.#scrollOffset = this.#options.state().panel
                ? Math.max(0, this.#scrollOffset - Math.max(4, this.#options.height() - 14))
                : this.#scrollOffset + Math.max(4, this.#options.height() - 14);
            this.#options.requestRender();
            return;
        }
        if (!this.#question && matchesKey(data, "pageDown")) {
            this.#scrollOffset = this.#options.state().panel
                ? this.#scrollOffset + Math.max(4, this.#options.height() - 14)
                : Math.max(0, this.#scrollOffset - Math.max(4, this.#options.height() - 14));
            this.#options.requestRender();
            return;
        }
        this.#input.handleInput(modifyOtherKeysPrintable(data) ?? data);
        this.#options.requestRender();
    }
    requestValue(label, options = {}) {
        if (this.#question)
            return Promise.reject(new Error("A TUI question is already active"));
        this.#input.setValue("");
        this.#secretValue = "";
        return new Promise((resolve) => {
            this.#question = { label, secret: options.secret ?? false, resolve };
            this.#options.requestRender();
        });
    }
    invalidate() {
        this.#input.invalidate();
    }
    dispose() {
        if (this.#animationTimer)
            clearInterval(this.#animationTimer);
        this.#animationTimer = undefined;
    }
    #handleSecretInput(data) {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
            this.#finishQuestion(undefined);
            return;
        }
        if (matchesKey(data, "enter")) {
            this.#finishQuestion(this.#secretValue);
            return;
        }
        if (matchesKey(data, "backspace")) {
            this.#secretValue = [...this.#secretValue].slice(0, -1).join("");
            return;
        }
        const pasted = bracketedPaste(data);
        const printable = pasted ?? decodeKittyPrintable(data) ?? modifyOtherKeysPrintable(data) ?? (/^[\x20-\x7e]+$/.test(data) ? data : undefined);
        if (printable && this.#secretValue.length + printable.length <= 16_384)
            this.#secretValue += printable;
    }
    #finishQuestion(value) {
        const question = this.#question;
        if (!question)
            return;
        this.#question = undefined;
        this.#input.setValue("");
        this.#secretValue = "";
        question.resolve(value);
        this.#options.requestRender();
    }
    #syncAnimation(active) {
        if (active && !this.#animationTimer) {
            this.#animationTimer = setInterval(() => this.#options.requestRender(), 120);
            this.#animationTimer.unref();
        }
        else if (!active && this.#animationTimer) {
            clearInterval(this.#animationTimer);
            this.#animationTimer = undefined;
        }
    }
}
export function renderTuiSnapshot(state, width = 160, height = 45, input = "", options = {}) {
    const safeWidth = Math.max(24, width);
    const safeHeight = Math.max(12, height);
    const innerWidth = safeWidth - 2;
    const wide = safeWidth >= 104;
    const color = options.color ?? true;
    const animationFrame = options.animationFrame ?? 0;
    const approvals = Object.values(state.kernel.approvals);
    const bodyRows = Math.max(1, safeHeight - (approvals.length > 0 ? 10 : 9));
    const metrics = kernelMetrics(state.kernel);
    const selected = state.kernel.sessions[state.selectedSessionId];
    const configuredModel = selected?.model ?? state.configuredModel;
    const model = configuredModel ? `${configuredModel.provider}/${configuredModel.model}` : "model not configured";
    const top = paint(`┌${"─".repeat(innerWidth)}┐`, "border", color);
    const header = fullRow(sideBySide(` ${paint("∴", "brand", color)} ${paint("pSpore", "brand", color)}  ${paint("LOCAL COWORK AGENT", "faint", color)}`, `${paint(state.connected ? "● ONLINE" : "○ OFFLINE", state.connected ? "live" : "muted", color)}   ${paint(model, "model", color)} `, innerWidth), innerWidth);
    const activeState = activeWorkLabel(state, animationFrame);
    const context = fullRow(sideBySide(` ${paint("session", "faint", color)} ${paint(shortId(state.selectedSessionId), "lichen", color)}   ${paint(activeState, selected?.status === "running" ? "honey" : "muted", color)}`, `${stat("context", selected?.context ? `~${formatTokens(selected.context.tokens)}` : "—", color)}   ${stat("total", formatTokens(selected?.usage.total ?? 0), color)}   ${stat("rev", String(state.kernel.revision), color)}   ${stat("approvals", String(metrics.pendingApprovals), color)} `, innerWidth), innerWidth);
    const offset = options.scrollOffset ?? 0;
    const mainWidth = wide ? contentWidth(innerWidth) : innerWidth - 2;
    let main;
    if (state.panel) {
        main = renderPanel(state.panel.title, state.panel.lines, mainWidth, color).slice(offset, offset + bodyRows);
    }
    else {
        // The conversation label stays pinned at the top while messages grow upward from the prompt.
        const rows = Math.max(1, bodyRows - 1);
        const heading = `${paint("CONVERSATION", "section", color)}  ${paint(shortId(state.selectedSessionId), "lichen", color)}`;
        const content = renderTranscriptWindow(state, mainWidth, color, animationFrame, rows, offset, options.onHistoryExhausted);
        main = [heading, ...anchorBottom(content, rows)];
    }
    let body;
    let bodyTop;
    let bodyBottom;
    if (wide) {
        const leftWidth = Math.min(31, Math.max(25, Math.floor(innerWidth * 0.2)));
        const rightWidth = innerWidth - leftWidth - 1;
        const left = composeColumn(renderSessionList(state, leftWidth - 2, color), renderWorkspaceSummary(state, leftWidth - 2, color), bodyRows);
        bodyTop = paint(`├${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┤`, "border", color);
        bodyBottom = paint(`├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`, "border", color);
        body = Array.from({ length: bodyRows }, (_, index) => (`│ ${cell(left[index] ?? "", leftWidth - 2)} │ ${cell(main[index] ?? "", rightWidth - 2)} │`));
    }
    else {
        bodyTop = paint(`├${"─".repeat(innerWidth)}┤`, "border", color);
        bodyBottom = bodyTop;
        body = Array.from({ length: bodyRows }, (_, index) => `│ ${cell(main[index] ?? "", innerWidth - 2)} │`);
    }
    const approval = approvals[0]
        ? fullRow(paint(` ! APPROVAL ${shortId(approvals[0].id)} · ${approvals[0].display.summary} · /approve or /deny`, "alert", color), innerWidth)
        : undefined;
    const noticeText = state.gap
        ? ` EVENT GAP ${state.gap.streamId}: expected ${state.gap.expected}, received ${state.gap.received}`
        : ` ${state.notice}`;
    const help = fullRow(` ${HELP_HINTS.map(([key, hint]) => `${paint(key, "bone", color)} ${paint(hint, "faint", color)}`).join("   ")}`, innerWidth);
    const target = shortId(state.selectedSessionId === "main"
        ? "main"
        : Object.values(state.kernel.agents).find((agent) => agent.sessionId === state.selectedSessionId)?.id ?? state.selectedSessionId);
    const label = options.promptLabel ?? `to ${target}`;
    const promptLabel = options.secretInput ? `secret ${label}` : label;
    const prompt = fullRow(` ${paint(promptLabel, options.secretInput ? "rust" : "faint", color)} ${paint("›", "brand", color)} ${input}`, innerWidth);
    return [
        top,
        header,
        context,
        bodyTop,
        ...body,
        bodyBottom,
        ...(approval ? [approval] : []),
        fullRow(paint(noticeText, state.gap ? "rust" : "muted", color), innerWidth),
        help,
        prompt,
        paint(`└${"─".repeat(innerWidth)}┘`, "border", color),
    ];
}
export function maskSecretInput(value, width) {
    if (!value)
        return "";
    const count = [...value].length;
    if (count <= width)
        return "•".repeat(count);
    return `${"•".repeat(Math.max(0, width - 1))}…`;
}
function contentWidth(innerWidth) {
    const leftWidth = Math.min(31, Math.max(25, Math.floor(innerWidth * 0.2)));
    return innerWidth - leftWidth - 3;
}
function renderSessionList(state, width, color) {
    const lines = [paint("SESSIONS", "section", color)];
    for (const item of presentSessions(state.kernel, state.selectedSessionId)) {
        // Child agents hang off main like hyphae, so the branch glyph carries the tree instead of a depth label.
        const branch = item.kind === "agent" ? paint("└─", "border", color) : " ";
        const marker = item.selected ? "●" : "○";
        const tone = item.selected ? "brand" : item.status === "running" ? "live" : "muted";
        lines.push(`${"  ".repeat(item.depth)}${branch}${paint(marker, tone, color)} ${paint(shortId(item.id), item.kind === "agent" ? "agent" : "lichen", color)}  ${paint(item.status, item.status === "running" ? "live" : "faint", color)}`);
        if (width >= 24 && (item.kind === "agent" || item.title !== "Main session")) {
            lines.push(paint(`${"  ".repeat(item.depth + 1)}  ${item.title}`, "faint", color));
        }
    }
    return lines.map((line) => truncateToWidth(line, width));
}
function renderWorkspaceSummary(state, width, color) {
    const metrics = kernelMetrics(state.kernel);
    const lines = [
        paint("WORKSPACE", "section", color),
        metric("runs", `${metrics.activeRuns}/${metrics.runs}`, color),
        metric("mcp", `${metrics.readyMcpServers}/${metrics.mcpServers}`, color),
        metric("resources", `${metrics.activeResources}/${metrics.resources}`, color),
        metric("approvals", String(metrics.pendingApprovals), color),
    ];
    const notification = state.kernel.notifications.at(-1);
    if (notification) {
        lines.push("", paint("LATEST", "section", color), `  ${paint(notification.level, notification.level === "error" ? "rust" : notification.level === "warning" ? "honey" : "faint", color)} ${paint(notification.title, "muted", color)}`);
    }
    return lines.map((line) => truncateToWidth(line, width));
}
function metric(label, value, color) {
    return `  ${paint(label.padEnd(11), "faint", color)}${paint(value, "muted", color)}`;
}
function renderTranscriptWindow(state, width, color, animationFrame, rows, offset, onHistoryExhausted) {
    const selected = state.kernel.sessions[state.selectedSessionId];
    const targetLines = Math.max(rows + Math.max(0, offset) + 8, rows);
    const tail = [];
    if (!selected || selected.messages.length === 0) {
        tail.push(paint("Ready. Describe a task below, or run /help for the command palette.", "muted", color), "");
        for (const example of EXAMPLE_TASKS) {
            tail.push(...wrapTextWithAnsi(paint(`  ${example}`, "faint", color), Math.max(1, width)));
        }
        tail.push("");
    }
    const activities = state.activities.filter((activity) => activity.sessionId === state.selectedSessionId).slice(-8);
    if (activities.length > 0)
        tail.push(...renderWorkSteps(activities, width, color, animationFrame), "");
    const thinking = state.streamingThinking[state.selectedSessionId];
    if (thinking)
        tail.push(...renderThinking(thinking, width, color), "");
    const streaming = state.streamingText[state.selectedSessionId];
    if (streaming)
        tail.push(...renderMessage({ role: "assistant(streaming)", text: streaming }, width, color));
    const childSelected = Object.values(state.kernel.agents).some((agent) => agent.sessionId === state.selectedSessionId);
    const queued = childSelected ? [] : (selected?.queue.followUp ?? []);
    if (queued.length > 0) {
        tail.push("", paint("QUEUED MESSAGES", "section", color));
        for (const [index, message] of queued.entries()) {
            const source = `${paint(`${index + 1}. 继续排队`, "honey", color)} · ${paint(message, "muted", color)} · ${paint(`/send-now ${index + 1} 直接发送消息`, "bone", color)}`;
            tail.push(...wrapTextWithAnsi(source, Math.max(1, width)));
        }
    }
    // Walk backward and stop once the requested terminal window plus a small
    // overscan is covered. Normal bottom-pinned rendering therefore formats only
    // the last handful of messages even when a restored session has thousands.
    const messageChunks = [];
    let collectedLines = tail.length;
    const messages = selected?.messages ?? [];
    for (let index = messages.length - 1; index >= 0 && collectedLines < targetLines; index -= 1) {
        const message = messages[index];
        if (!message)
            continue;
        const rendered = renderMessage(message, width, color);
        if (rendered.length === 0)
            continue;
        const chunk = [...rendered, ""];
        messageChunks.unshift(chunk);
        collectedLines += chunk.length;
    }
    // Every loaded message was formatted and the window still is not filled: the
    // reader has scrolled past everything this client holds.
    if (offset > 0 && collectedLines < targetLines)
        onHistoryExhausted?.();
    const content = [...messageChunks.flat(), ...tail];
    return windowLines(content, rows, offset);
}
function renderPanel(title, values, width, color) {
    const lines = [`${paint(title.toUpperCase(), "section", color)}  ${paint("·  /back to conversation", "muted", color)}`, ""];
    if (values.length === 0)
        return [...lines, "No entries."];
    for (const value of values)
        lines.push(...wrapTextWithAnsi(value, Math.max(1, width)));
    return lines;
}
function renderMessage(message, width, color) {
    const normalizedRole = message.role.toLowerCase();
    if (normalizedRole.includes("tool"))
        return [];
    const agent = normalizedRole.includes("assistant");
    const role = agent ? "pSpore" : "you";
    const tone = agent ? "agent" : "lichen";
    // A fixed speaker gutter keeps every message body on the same left edge.
    const prefix = paint(role.padEnd(ROLE_GUTTER), tone, color);
    const continuation = " ".repeat(Math.min(ROLE_GUTTER, width));
    const text = cleanMessageText(message.text);
    if (!text)
        return [];
    const wrapped = wrapTextWithAnsi(text, Math.max(1, width - visibleWidth(prefix)));
    return wrapped.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
}
function renderThinking(value, width, color) {
    const prefix = paint("thought".padEnd(ROLE_GUTTER), "faint", color);
    const continuation = " ".repeat(Math.min(ROLE_GUTTER, width));
    const wrapped = wrapTextWithAnsi(value.trim(), Math.max(1, width - visibleWidth(prefix)));
    const lines = wrapped.map((line, index) => `${index === 0 ? prefix : continuation}${paint(line, "muted", color)}`);
    return [
        ...lines,
        `${continuation}${paint("(auto-hidden when the response completes)", "faint", color)}`,
    ];
}
function renderWorkSteps(activities, width, color, animationFrame) {
    const lines = [paint("WORK STEPS", "section", color)];
    for (const activity of activities) {
        const running = activity.status === "running";
        const icon = running
            ? SPINNER_FRAMES[Math.abs(animationFrame) % SPINNER_FRAMES.length]
            : activity.status === "failed" ? "✕" : "✓";
        const tone = running ? "honey" : activity.status === "failed" ? "rust" : activity.toolName?.startsWith("memory_") ? "memory" : "live";
        const result = activity.resultSummary ? ` · ${activity.resultSummary}` : "";
        const duration = activity.durationMs === undefined ? "" : ` · ${formatDuration(activity.durationMs)}`;
        const source = `${paint(icon ?? "·", tone, color)} ${paint(activity.label, tone, color)} · ${paint(`${activity.summary}${result}${duration}`, "muted", color)}`;
        lines.push(...wrapTextWithAnsi(source, Math.max(1, width)));
    }
    lines.push(paint("  /work for history and redacted technical details", "faint", color));
    return lines;
}
function windowLines(lines, rows, offset) {
    const end = Math.max(0, lines.length - Math.max(0, offset));
    const start = Math.max(0, end - rows);
    return lines.slice(start, end);
}
function anchorBottom(lines, rows) {
    if (lines.length >= rows)
        return lines.slice(lines.length - rows);
    return [...Array.from({ length: rows - lines.length }, () => ""), ...lines];
}
function composeColumn(top, bottom, rows) {
    if (bottom.length >= rows)
        return [...bottom].slice(0, rows);
    const visibleTop = top.slice(0, Math.max(0, rows - bottom.length - 1));
    const gap = rows - visibleTop.length - bottom.length;
    return [...visibleTop, ...Array.from({ length: gap }, () => ""), ...bottom];
}
function sideBySide(left, right, width) {
    const spare = width - visibleWidth(left) - visibleWidth(right);
    return spare < 1 ? `${left} ${right}` : `${left}${" ".repeat(spare)}${right}`;
}
function stat(label, value, color) {
    return `${paint(label, "faint", color)} ${paint(value, "muted", color)}`;
}
/**
 * The character an xterm-style `CSI 27 ; modifiers ; codepoint ~` key carries.
 * Pi's TUI falls back to this modifyOtherKeys mode on terminals without the
 * Kitty keyboard protocol (xterm among them), where Shift+letter arrives in
 * this form; its Input only decodes the Kitty form, so every capital letter
 * typed in xterm was dropped. Only Shift and the lock keys may be held, as in
 * Pi's own decoder: anything with Ctrl or Alt stays a shortcut.
 */
export function modifyOtherKeysPrintable(data) {
    const match = /^\u001b\[27;(\d+);(\d+)~$/.exec(data);
    if (!match)
        return undefined;
    const modifier = Number(match[1]) - 1;
    const codepoint = Number(match[2]);
    const SHIFT = 1;
    const LOCKS = 64 + 128;
    if ((modifier & ~(SHIFT | LOCKS)) !== 0 || !Number.isInteger(codepoint) || codepoint < 32 || codepoint === 127)
        return undefined;
    try {
        return String.fromCodePoint(codepoint);
    }
    catch {
        // Out of the Unicode range: not a character to insert.
        return undefined;
    }
}
function bracketedPaste(data) {
    const prefix = "\u001b[200~";
    const suffix = "\u001b[201~";
    if (!data.startsWith(prefix) || !data.endsWith(suffix))
        return undefined;
    const value = data.slice(prefix.length, -suffix.length);
    return /[\r\n\u0000]/.test(value) ? undefined : value;
}
// ASCII frames stay legible in minimal Linux consoles where Braille spinner
// glyphs otherwise appear as tofu boxes or width-ambiguous symbols.
const SPINNER_FRAMES = [".", "o", "O", "o"];
const ROLE_GUTTER = 8;
const EXAMPLE_TASKS = [
    "organise ~/Downloads: archive last week's files by type, plan first",
    "find the 10 largest directories on this machine",
    "every day at 09:00, summarise yesterday's log errors into memory",
];
const HELP_HINTS = [
    ["/help", "commands"],
    ["/work", "details"],
    ["/config", "setup"],
    ["PgUp/PgDn", "history"],
    ["Ctrl+C", "abort/exit"],
];
const ANSI = {
    agent: "\u001b[38;5;151m",
    alert: "\u001b[1;38;5;179m",
    bone: "\u001b[38;5;187m",
    border: "\u001b[38;5;240m",
    brand: "\u001b[1;38;5;187m",
    faint: "\u001b[38;5;242m",
    honey: "\u001b[38;5;179m",
    lichen: "\u001b[38;5;109m",
    live: "\u001b[38;5;108m",
    memory: "\u001b[38;5;182m",
    model: "\u001b[38;5;144m",
    muted: "\u001b[38;5;245m",
    rust: "\u001b[38;5;174m",
    section: "\u001b[1;38;5;250m",
};
function paint(value, tone, color) {
    return color && value ? `${ANSI[tone]}${value}\u001b[0m` : value;
}
function activeWorkLabel(state, animationFrame) {
    const selected = state.kernel.sessions[state.selectedSessionId];
    if (selected?.status !== "running")
        return selected?.status ?? "idle";
    const spinner = SPINNER_FRAMES[Math.abs(animationFrame) % SPINNER_FRAMES.length] ?? "·";
    const activity = [...state.activities].reverse().find((item) => (item.sessionId === state.selectedSessionId && item.status === "running"));
    if (activity)
        return `${spinner} ${activity.label}`;
    if (state.streamingText[state.selectedSessionId])
        return `${spinner} Writing response`;
    if (state.streamingThinking[state.selectedSessionId])
        return `${spinner} Thinking`;
    return `${spinner} Thinking`;
}
function hasMotion(state) {
    const selected = state.kernel.sessions[state.selectedSessionId];
    return selected?.status === "running"
        || state.activities.some((activity) => activity.sessionId === state.selectedSessionId && activity.status === "running");
}
function cleanMessageText(value) {
    return value
        .split("\n")
        .filter((line) => !/^\[tool:[^\]]+\]$/.test(line.trim()))
        .join("\n")
        .trim();
}
function cell(value, width) {
    return truncateToWidth(value, width, "…", true);
}
function fullRow(value, width) {
    return `│${cell(value, width)}│`;
}
//# sourceMappingURL=view.js.map