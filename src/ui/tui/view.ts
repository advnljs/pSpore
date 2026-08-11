import {
  Input,
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

import type { RuntimeMessage } from "../../domain/runtime.js";
import { formatTokens, kernelMetrics, presentSessions, shortId } from "../shared/presentation.js";
import type { TuiStoreSnapshot } from "./store.js";

export interface TuiViewOptions {
  state: () => TuiStoreSnapshot;
  height: () => number;
  requestRender: () => void;
  onSubmit: (input: string) => void;
  onInterrupt: () => void;
  onBack: () => void;
}

export interface TuiRenderOptions {
  scrollOffset?: number;
  promptLabel?: string;
  secretInput?: boolean;
}

interface Question {
  label: string;
  secret: boolean;
  resolve(value: string | undefined): void;
}

export class PsporeTuiView implements Component, Focusable {
  focused = false;
  readonly #options: TuiViewOptions;
  readonly #input = new Input();
  #question: Question | undefined;
  #secretValue = "";
  #scrollOffset = 0;

  constructor(options: TuiViewOptions) {
    this.#options = options;
    this.#input.onSubmit = (value) => {
      if (this.#question) {
        this.#finishQuestion(value);
        return;
      }
      const input = value.trim();
      if (!input) return;
      this.#input.setValue("");
      this.#scrollOffset = 0;
      options.onSubmit(input);
      options.requestRender();
    };
    this.#input.onEscape = () => {
      if (this.#question) this.#finishQuestion(undefined);
      else options.onBack();
      options.requestRender();
    };
  }

  render(width: number): string[] {
    this.#input.focused = this.focused;
    const input = this.#question?.secret
      ? maskSecretInput(this.#secretValue, Math.max(1, width - 22))
      : this.#input.render(Math.max(1, width - 22))[0] ?? "";
    return renderTuiSnapshot(this.#options.state(), width, this.#options.height(), input, {
      scrollOffset: this.#scrollOffset,
      ...(this.#question ? { promptLabel: this.#question.label, secretInput: this.#question.secret } : {}),
    });
  }

  handleInput(data: string): void {
    if (this.#question?.secret) {
      this.#handleSecretInput(data);
      this.#options.requestRender();
      return;
    }
    if (matchesKey(data, "ctrl+c")) {
      if (this.#question) this.#finishQuestion(undefined);
      else this.#options.onInterrupt();
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
    this.#input.handleInput(data);
    this.#options.requestRender();
  }

  requestValue(label: string, options: { secret?: boolean } = {}): Promise<string | undefined> {
    if (this.#question) return Promise.reject(new Error("A TUI question is already active"));
    this.#input.setValue("");
    this.#secretValue = "";
    return new Promise((resolve) => {
      this.#question = { label, secret: options.secret ?? false, resolve };
      this.#options.requestRender();
    });
  }

  invalidate(): void {
    this.#input.invalidate();
  }

  #handleSecretInput(data: string): void {
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
    const printable = pasted ?? decodeKittyPrintable(data) ?? (/^[\x20-\x7e]+$/.test(data) ? data : undefined);
    if (printable && this.#secretValue.length + printable.length <= 16_384) this.#secretValue += printable;
  }

  #finishQuestion(value: string | undefined): void {
    const question = this.#question;
    if (!question) return;
    this.#question = undefined;
    this.#input.setValue("");
    this.#secretValue = "";
    question.resolve(value);
    this.#options.requestRender();
  }
}

export function renderTuiSnapshot(
  state: TuiStoreSnapshot,
  width = 160,
  height = 45,
  input = "",
  options: TuiRenderOptions = {},
): string[] {
  const safeWidth = Math.max(24, width);
  const safeHeight = Math.max(12, height);
  const innerWidth = safeWidth - 2;
  const wide = safeWidth >= 104;
  const approvals = Object.values(state.kernel.approvals);
  const bodyRows = Math.max(1, safeHeight - (approvals.length > 0 ? 11 : 10));
  const metrics = kernelMetrics(state.kernel);
  const selected = state.kernel.sessions[state.selectedSessionId];
  const model = selected?.model ? `${selected.model.provider}/${selected.model.model}` : "model not configured";
  const top = `┌${"─".repeat(innerWidth)}┐`;
  const header = fullRow(
    ` pSpore  LOCAL AGENT   ${state.connected ? "● ONLINE" : "○ OFFLINE"}   ${model}`,
    innerWidth,
  );
  const context = fullRow(
    ` target ${shortId(state.selectedSessionId)} · ${selected?.status ?? "idle"}   context ${formatTokens(selected?.usage.total ?? 0)}   rev ${state.kernel.revision}   approvals ${metrics.pendingApprovals}`,
    innerWidth,
  );
  const content = state.panel
    ? renderPanel(state.panel.title, state.panel.lines, wide ? contentWidth(innerWidth) : innerWidth - 2)
    : renderTranscript(state, wide ? contentWidth(innerWidth) : innerWidth - 2);
  const offset = options.scrollOffset ?? 0;
  const main = state.panel ? content.slice(offset, offset + bodyRows) : windowLines(content, bodyRows, offset);
  let body: string[];
  let bodyTop: string;
  let bodyBottom: string;
  if (wide) {
    const leftWidth = Math.min(31, Math.max(25, Math.floor(innerWidth * 0.2)));
    const rightWidth = innerWidth - leftWidth - 1;
    const left = windowLines(renderSidebar(state, leftWidth - 2), bodyRows, 0, true);
    bodyTop = `├${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┤`;
    bodyBottom = `├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`;
    body = Array.from({ length: bodyRows }, (_, index) => (
      `│ ${cell(left[index] ?? "", leftWidth - 2)} │ ${cell(main[index] ?? "", rightWidth - 2)} │`
    ));
  } else {
    bodyTop = `├${"─".repeat(innerWidth)}┤`;
    bodyBottom = bodyTop;
    body = Array.from({ length: bodyRows }, (_, index) => `│ ${cell(main[index] ?? "", innerWidth - 2)} │`);
  }
  const approval = approvals[0]
    ? fullRow(` ! APPROVAL ${shortId(approvals[0].id)} · ${approvals[0].display.summary} · /approve or /deny`, innerWidth)
    : undefined;
  const noticeText = state.gap
    ? ` EVENT GAP ${state.gap.streamId}: expected ${state.gap.expected}, received ${state.gap.received}`
    : ` ${state.notice}`;
  const divider = `├${"─".repeat(innerWidth)}┤`;
  const help = fullRow(" /help commands   /config wizard   /back conversation   PgUp/PgDn history   Ctrl+C abort/exit", innerWidth);
  const target = shortId(state.selectedSessionId === "main"
    ? "main"
    : Object.values(state.kernel.agents).find((agent) => agent.sessionId === state.selectedSessionId)?.id ?? state.selectedSessionId);
  const label = options.promptLabel ?? `to ${target}`;
  const prompt = fullRow(` ${options.secretInput ? "secret " : ""}${label} › ${input}`, innerWidth);
  return [
    top,
    header,
    context,
    bodyTop,
    ...body,
    bodyBottom,
    ...(approval ? [approval] : []),
    fullRow(noticeText, innerWidth),
    divider,
    help,
    prompt,
    `└${"─".repeat(innerWidth)}┘`,
  ];
}

export function maskSecretInput(value: string, width: number): string {
  if (!value) return "";
  const count = [...value].length;
  if (count <= width) return "•".repeat(count);
  return `${"•".repeat(Math.max(0, width - 1))}…`;
}

function contentWidth(innerWidth: number): number {
  const leftWidth = Math.min(31, Math.max(25, Math.floor(innerWidth * 0.2)));
  return innerWidth - leftWidth - 3;
}

function renderSidebar(state: TuiStoreSnapshot, width: number): string[] {
  const lines = ["SESSIONS"];
  for (const item of presentSessions(state.kernel, state.selectedSessionId)) {
    const marker = item.selected ? "●" : item.kind === "agent" ? "↳" : "○";
    lines.push(`${"  ".repeat(item.depth)}${marker} ${shortId(item.id)}  ${item.status}`);
    if (item.kind === "agent" && width >= 24) lines.push(`${"  ".repeat(item.depth + 1)}${item.title}`);
  }
  const metrics = kernelMetrics(state.kernel);
  lines.push(
    "",
    "WORKSPACE",
    `  runs       ${metrics.activeRuns}/${metrics.runs}`,
    `  mcp        ${metrics.readyMcpServers}/${metrics.mcpServers}`,
    `  resources  ${metrics.activeResources}/${metrics.resources}`,
    `  approvals  ${metrics.pendingApprovals}`,
  );
  const notification = state.kernel.notifications.at(-1);
  if (notification) lines.push("", "LATEST", `  ${notification.level} · ${notification.title}`);
  return lines.map((line) => truncateToWidth(line, width));
}

function renderTranscript(state: TuiStoreSnapshot, width: number): string[] {
  const selected = state.kernel.sessions[state.selectedSessionId];
  const lines = [`CONVERSATION  ${shortId(state.selectedSessionId)}`, ""];
  if (!selected || selected.messages.length === 0) {
    lines.push("Ready. Describe a task below, or use /help to open the command palette.");
  }
  for (const message of selected?.messages ?? []) lines.push(...renderMessage(message, width), "");
  const streaming = state.streamingText[state.selectedSessionId];
  if (streaming) lines.push(...renderMessage({ role: "assistant(streaming)", text: streaming }, width));
  return lines;
}

function renderPanel(title: string, values: readonly string[], width: number): string[] {
  const lines = [`${title.toUpperCase()}  ·  /back to conversation`, ""];
  if (values.length === 0) return [...lines, "No entries."];
  for (const value of values) lines.push(...wrapTextWithAnsi(value, Math.max(1, width)));
  return lines;
}

function renderMessage(message: RuntimeMessage, width: number): string[] {
  const role = message.role.toLowerCase().includes("tool")
    ? "tool"
    : message.role.toLowerCase().includes("assistant") ? "pSpore" : "you";
  const prefix = `${role}  `;
  const continuation = " ".repeat(Math.min(visibleWidth(prefix), width));
  const wrapped = wrapTextWithAnsi(message.text || "(empty)", Math.max(1, width - visibleWidth(prefix)));
  return wrapped.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
}

function windowLines(lines: readonly string[], rows: number, offset: number, fromStart = false): string[] {
  if (fromStart) return lines.slice(0, rows);
  const end = Math.max(0, lines.length - Math.max(0, offset));
  const start = Math.max(0, end - rows);
  return lines.slice(start, end);
}

function bracketedPaste(data: string): string | undefined {
  const prefix = "\u001b[200~";
  const suffix = "\u001b[201~";
  if (!data.startsWith(prefix) || !data.endsWith(suffix)) return undefined;
  const value = data.slice(prefix.length, -suffix.length);
  return /[\r\n\u0000]/.test(value) ? undefined : value;
}

function cell(value: string, width: number): string {
  return truncateToWidth(value, width, "…", true);
}

function fullRow(value: string, width: number): string {
  return `│${cell(value, width)}│`;
}
