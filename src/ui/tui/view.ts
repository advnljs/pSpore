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
import { formatDuration, type CoworkActivity } from "../shared/activity.js";
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
  color?: boolean;
  animationFrame?: number;
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
  #animationTimer: NodeJS.Timeout | undefined;

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
    const state = this.#options.state();
    this.#syncAnimation(hasMotion(state));
    this.#input.focused = this.focused;
    const input = this.#question?.secret
      ? maskSecretInput(this.#secretValue, Math.max(1, width - 22))
      : this.#input.render(Math.max(1, width - 22))[0] ?? "";
    return renderTuiSnapshot(state, width, this.#options.height(), input, {
      scrollOffset: this.#scrollOffset,
      color: process.env["NO_COLOR"] === undefined && process.env["TERM"] !== "dumb",
      animationFrame: Math.floor(Date.now() / 120),
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

  dispose(): void {
    if (this.#animationTimer) clearInterval(this.#animationTimer);
    this.#animationTimer = undefined;
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

  #syncAnimation(active: boolean): void {
    if (active && !this.#animationTimer) {
      this.#animationTimer = setInterval(() => this.#options.requestRender(), 120);
      this.#animationTimer.unref();
    } else if (!active && this.#animationTimer) {
      clearInterval(this.#animationTimer);
      this.#animationTimer = undefined;
    }
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
  const color = options.color ?? true;
  const animationFrame = options.animationFrame ?? 0;
  const approvals = Object.values(state.kernel.approvals);
  const bodyRows = Math.max(1, safeHeight - (approvals.length > 0 ? 11 : 10));
  const metrics = kernelMetrics(state.kernel);
  const selected = state.kernel.sessions[state.selectedSessionId];
  const configuredModel = selected?.model ?? state.configuredModel;
  const model = configuredModel ? `${configuredModel.provider}/${configuredModel.model}` : "model not configured";
  const top = paint(`┌${"─".repeat(innerWidth)}┐`, "border", color);
  const connection = paint(state.connected ? "● ONLINE" : "○ OFFLINE", state.connected ? "success" : "muted", color);
  const header = fullRow(
    ` ${paint("pSpore", "brand", color)}  ${paint("LOCAL COWORK AGENT", "muted", color)}   ${connection}   ${paint(model, "model", color)}`,
    innerWidth,
  );
  const activeState = activeWorkLabel(state, animationFrame);
  const context = fullRow(
    ` target ${paint(shortId(state.selectedSessionId), "user", color)} · ${paint(activeState, selected?.status === "running" ? "working" : "muted", color)}   context ${formatTokens(selected?.usage.total ?? 0)}   rev ${state.kernel.revision}   approvals ${metrics.pendingApprovals}`,
    innerWidth,
  );
  const content = state.panel
    ? renderPanel(state.panel.title, state.panel.lines, wide ? contentWidth(innerWidth) : innerWidth - 2, color)
    : renderTranscript(state, wide ? contentWidth(innerWidth) : innerWidth - 2, color, animationFrame);
  const offset = options.scrollOffset ?? 0;
  const main = state.panel ? content.slice(offset, offset + bodyRows) : windowLines(content, bodyRows, offset);
  let body: string[];
  let bodyTop: string;
  let bodyBottom: string;
  if (wide) {
    const leftWidth = Math.min(31, Math.max(25, Math.floor(innerWidth * 0.2)));
    const rightWidth = innerWidth - leftWidth - 1;
    const left = windowLines(renderSidebar(state, leftWidth - 2, color), bodyRows, 0, true);
    bodyTop = paint(`├${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┤`, "border", color);
    bodyBottom = paint(`├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`, "border", color);
    body = Array.from({ length: bodyRows }, (_, index) => (
      `│ ${cell(left[index] ?? "", leftWidth - 2)} │ ${cell(main[index] ?? "", rightWidth - 2)} │`
    ));
  } else {
    bodyTop = paint(`├${"─".repeat(innerWidth)}┤`, "border", color);
    bodyBottom = bodyTop;
    body = Array.from({ length: bodyRows }, (_, index) => `│ ${cell(main[index] ?? "", innerWidth - 2)} │`);
  }
  const approval = approvals[0]
    ? fullRow(paint(` ! APPROVAL ${shortId(approvals[0].id)} · ${approvals[0].display.summary} · /approve or /deny`, "danger", color), innerWidth)
    : undefined;
  const noticeText = state.gap
    ? ` EVENT GAP ${state.gap.streamId}: expected ${state.gap.expected}, received ${state.gap.received}`
    : ` ${state.notice}`;
  const divider = paint(`├${"─".repeat(innerWidth)}┤`, "border", color);
  const help = fullRow(paint(" /help commands   /work details   /config setup   PgUp/PgDn history   Ctrl+C abort/exit", "muted", color), innerWidth);
  const target = shortId(state.selectedSessionId === "main"
    ? "main"
    : Object.values(state.kernel.agents).find((agent) => agent.sessionId === state.selectedSessionId)?.id ?? state.selectedSessionId);
  const label = options.promptLabel ?? `to ${target}`;
  const promptLabel = options.secretInput ? `secret ${label}` : label;
  const prompt = fullRow(` ${paint(promptLabel, options.secretInput ? "danger" : "user", color)} ${paint("›", "brand", color)} ${input}`, innerWidth);
  return [
    top,
    header,
    context,
    bodyTop,
    ...body,
    bodyBottom,
    ...(approval ? [approval] : []),
    fullRow(paint(noticeText, state.gap ? "danger" : "muted", color), innerWidth),
    divider,
    help,
    prompt,
    paint(`└${"─".repeat(innerWidth)}┘`, "border", color),
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

function renderSidebar(state: TuiStoreSnapshot, width: number, color: boolean): string[] {
  const lines = [paint("SESSIONS", "section", color)];
  for (const item of presentSessions(state.kernel, state.selectedSessionId)) {
    const marker = item.selected ? "●" : item.kind === "agent" ? "↳" : "○";
    const tone = item.selected ? "brand" : item.status === "running" ? "working" : "muted";
    lines.push(`${"  ".repeat(item.depth)}${paint(marker, tone, color)} ${paint(shortId(item.id), item.kind === "agent" ? "agent" : "user", color)}  ${item.status}`);
    if (item.kind === "agent" && width >= 24) lines.push(paint(`${"  ".repeat(item.depth + 1)}${item.title}`, "muted", color));
  }
  const metrics = kernelMetrics(state.kernel);
  lines.push(
    "",
    paint("WORKSPACE", "section", color),
    `  runs       ${metrics.activeRuns}/${metrics.runs}`,
    `  mcp        ${metrics.readyMcpServers}/${metrics.mcpServers}`,
    `  resources  ${metrics.activeResources}/${metrics.resources}`,
    `  approvals  ${metrics.pendingApprovals}`,
  );
  const notification = state.kernel.notifications.at(-1);
  if (notification) lines.push("", paint("LATEST", "section", color), `  ${notification.level} · ${notification.title}`);
  return lines.map((line) => truncateToWidth(line, width));
}

function renderTranscript(state: TuiStoreSnapshot, width: number, color: boolean, animationFrame: number): string[] {
  const selected = state.kernel.sessions[state.selectedSessionId];
  const lines = [
    `${paint("CONVERSATION", "section", color)}  ${paint(shortId(state.selectedSessionId), "user", color)}`,
    "",
  ];
  if (!selected || selected.messages.length === 0) {
    lines.push(paint("Ready. Describe a task below, or use /help to open the command palette.", "muted", color));
  }
  for (const message of selected?.messages ?? []) {
    const rendered = renderMessage(message, width, color);
    if (rendered.length > 0) lines.push(...rendered, "");
  }
  const activities = state.activities.filter((activity) => activity.sessionId === state.selectedSessionId).slice(-8);
  if (activities.length > 0) lines.push(...renderWorkSteps(activities, width, color, animationFrame), "");
  const streaming = state.streamingText[state.selectedSessionId];
  if (streaming) lines.push(...renderMessage({ role: "assistant(streaming)", text: streaming }, width, color));
  return lines;
}

function renderPanel(title: string, values: readonly string[], width: number, color: boolean): string[] {
  const lines = [`${paint(title.toUpperCase(), "section", color)}  ${paint("·  /back to conversation", "muted", color)}`, ""];
  if (values.length === 0) return [...lines, "No entries."];
  for (const value of values) lines.push(...wrapTextWithAnsi(value, Math.max(1, width)));
  return lines;
}

function renderMessage(message: RuntimeMessage, width: number, color: boolean): string[] {
  const normalizedRole = message.role.toLowerCase();
  if (normalizedRole.includes("tool")) return [];
  const agent = normalizedRole.includes("assistant");
  const role = agent ? "pSpore" : "you";
  const tone = agent ? "agent" : "user";
  const prefix = `${paint(role, tone, color)}  `;
  const continuation = " ".repeat(Math.min(visibleWidth(prefix), width));
  const text = cleanMessageText(message.text);
  if (!text) return [];
  const wrapped = wrapTextWithAnsi(text, Math.max(1, width - visibleWidth(prefix)));
  return wrapped.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
}

function renderWorkSteps(
  activities: readonly CoworkActivity[],
  width: number,
  color: boolean,
  animationFrame: number,
): string[] {
  const lines = [paint("WORK STEPS", "section", color)];
  for (const activity of activities) {
    const running = activity.status === "running";
    const icon = running
      ? SPINNER_FRAMES[Math.abs(animationFrame) % SPINNER_FRAMES.length]
      : activity.status === "failed" ? "✕" : "✓";
    const tone = running ? "working" : activity.status === "failed" ? "danger" : activity.toolName?.startsWith("memory_") ? "memory" : "success";
    const result = activity.resultSummary ? ` · ${activity.resultSummary}` : "";
    const duration = activity.durationMs === undefined ? "" : ` · ${formatDuration(activity.durationMs)}`;
    const source = `${paint(icon ?? "·", tone, color)} ${paint(activity.label, tone, color)} · ${activity.summary}${result}${duration}`;
    lines.push(...wrapTextWithAnsi(source, Math.max(1, width)));
  }
  lines.push(paint("  /work for history and redacted technical details", "muted", color));
  return lines;
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

const SPINNER_FRAMES = ["⣋", "⣙", "⣹", "⣸", "⣼", "⣴", "⣦", "⣧", "⣇", "⣏"] as const;

type Tone = "agent" | "border" | "brand" | "danger" | "memory" | "model" | "muted" | "section" | "success" | "user" | "working";

const ANSI: Readonly<Record<Tone, string>> = {
  agent: "\u001b[38;5;114m",
  border: "\u001b[38;5;240m",
  brand: "\u001b[1;38;5;141m",
  danger: "\u001b[1;38;5;203m",
  memory: "\u001b[38;5;177m",
  model: "\u001b[38;5;109m",
  muted: "\u001b[38;5;244m",
  section: "\u001b[1;38;5;250m",
  success: "\u001b[38;5;78m",
  user: "\u001b[38;5;75m",
  working: "\u001b[38;5;214m",
};

function paint(value: string, tone: Tone, color: boolean): string {
  return color && value ? `${ANSI[tone]}${value}\u001b[0m` : value;
}

function activeWorkLabel(state: TuiStoreSnapshot, animationFrame: number): string {
  const selected = state.kernel.sessions[state.selectedSessionId];
  if (selected?.status !== "running") return selected?.status ?? "idle";
  const spinner = SPINNER_FRAMES[Math.abs(animationFrame) % SPINNER_FRAMES.length] ?? "·";
  const activity = [...state.activities].reverse().find((item) => (
    item.sessionId === state.selectedSessionId && item.status === "running"
  ));
  if (activity) return `${spinner} ${activity.label}`;
  if (state.streamingText[state.selectedSessionId]) return `${spinner} Writing response`;
  return `${spinner} Thinking`;
}

function hasMotion(state: TuiStoreSnapshot): boolean {
  const selected = state.kernel.sessions[state.selectedSessionId];
  return selected?.status === "running"
    || state.activities.some((activity) => activity.sessionId === state.selectedSessionId && activity.status === "running");
}

function cleanMessageText(value: string): string {
  return value
    .split("\n")
    .filter((line) => !/^\[tool:[^\]]+\]$/.test(line.trim()))
    .join("\n")
    .trim();
}

function cell(value: string, width: number): string {
  return truncateToWidth(value, width, "…", true);
}

function fullRow(value: string, width: number): string {
  return `│${cell(value, width)}│`;
}
