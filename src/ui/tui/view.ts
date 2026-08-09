import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";

import type { RuntimeMessage } from "../../domain/runtime.js";
import type { TuiStoreSnapshot } from "./store.js";

export interface TuiViewOptions {
  state: () => TuiStoreSnapshot;
  height: () => number;
  requestRender: () => void;
  onSubmit: (input: string) => void;
  onInterrupt: () => void;
}

export class PsporeTuiView implements Component, Focusable {
  focused = false;
  readonly #options: TuiViewOptions;
  readonly #input = new Input();

  constructor(options: TuiViewOptions) {
    this.#options = options;
    this.#input.onSubmit = (value) => {
      const input = value.trim();
      if (!input) return;
      this.#input.setValue("");
      options.onSubmit(input);
      options.requestRender();
    };
  }

  render(width: number): string[] {
    this.#input.focused = this.focused;
    const input = this.#input.render(Math.max(1, width - 10))[0] ?? "";
    return renderTuiSnapshot(this.#options.state(), width, this.#options.height(), input);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.#options.onInterrupt();
      return;
    }
    this.#input.handleInput(data);
    this.#options.requestRender();
  }

  invalidate(): void {
    this.#input.invalidate();
  }
}

export function renderTuiSnapshot(state: TuiStoreSnapshot, width = 160, height = 45, input = ""): string[] {
  const safeWidth = Math.max(60, width);
  const safeHeight = Math.max(18, height);
  const innerWidth = safeWidth - 2;
  const leftWidth = Math.min(28, Math.max(20, Math.floor(innerWidth * 0.2)));
  const rightWidth = innerWidth - leftWidth - 1;
  const bodyRows = safeHeight - 10;
  const top = `┌${"─".repeat(innerWidth)}┐`;
  const header = fullRow(
    ` pSpore v1 core  daemon:${state.kernel.daemon.phase}  ${state.connected ? "connected" : "disconnected"}  revision:${state.kernel.revision}`,
    innerWidth,
  );
  const splitTop = `├${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┤`;
  const splitBottom = `├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`;
  const left = renderSidebar(state, leftWidth - 2);
  const right = renderTranscript(state, rightWidth - 2);
  const body: string[] = [];
  for (let index = 0; index < bodyRows; index++) {
    body.push(`│ ${cell(left[index] ?? "", leftWidth - 2)} │ ${cell(right[index] ?? "", rightWidth - 2)} │`);
  }
  const approvals = Object.values(state.kernel.approvals);
  const approvalText = approvals[0]
    ? ` APPROVAL ${approvals[0].id}: ${approvals[0].display.summary}  (/approve ${approvals[0].id} | /deny ${approvals[0].id})`
    : " APPROVAL none";
  const notice = state.gap
    ? ` EVENT GAP ${state.gap.streamId}: expected ${state.gap.expected}, received ${state.gap.received}`
    : ` ${state.notice}`;
  const divider = `├${"─".repeat(innerWidth)}┤`;
  const help = " /steer TEXT  /follow TEXT  /abort  /compact  /approve ID  /deny ID  /quit    Ctrl+C abort/exit";
  const prompt = ` prompt> ${input}`;
  return [
    top,
    header,
    splitTop,
    ...body,
    splitBottom,
    fullRow(approvalText, innerWidth),
    fullRow(notice, innerWidth),
    divider,
    fullRow(help, innerWidth),
    fullRow(prompt, innerWidth),
    `└${"─".repeat(innerWidth)}┘`,
  ];
}

function renderSidebar(state: TuiStoreSnapshot, width: number): string[] {
  const sessions = Object.values(state.kernel.sessions);
  const lines = ["SESSIONS"];
  if (sessions.length === 0) lines.push("  main  not started");
  for (const session of sessions) lines.push(`› ${session.sessionId}  ${session.status}`);
  lines.push("", "DAEMON", `  ${state.kernel.daemon.phase}`, `  seq ${Math.max(0, ...Object.values(state.cursors))}`);
  const main = state.kernel.sessions["main"];
  if (main) {
    lines.push(
      "",
      "USAGE",
      `  in     ${main.usage.input}`,
      `  out    ${main.usage.output}`,
      `  cache  ${main.usage.cacheRead}/${main.usage.cacheWrite}`,
      "",
      "QUEUE",
      `  steer  ${main.queue.steering.length}`,
      `  follow ${main.queue.followUp.length}`,
    );
  }
  return lines.map((line) => truncateToWidth(line, width));
}

function renderTranscript(state: TuiStoreSnapshot, width: number): string[] {
  const main = state.kernel.sessions["main"];
  const lines = ["TRANSCRIPT  main"];
  if (!main || main.messages.length === 0) lines.push("No messages yet. Type a prompt below.");
  for (const message of main?.messages ?? []) lines.push(...renderMessage(message, width));
  const streaming = state.streamingText["main"];
  if (streaming) lines.push(...renderMessage({ role: "assistant(streaming)", text: streaming }, width));
  return lines;
}

function renderMessage(message: RuntimeMessage, width: number): string[] {
  const prefix = `${message.role}> `;
  const continuation = " ".repeat(Math.min(prefix.length, width));
  const wrapped = wrapTextWithAnsi(message.text || "(empty)", Math.max(1, width - visibleWidth(prefix)));
  return wrapped.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
}

function cell(value: string, width: number): string {
  return truncateToWidth(value, width, "…", true);
}

function fullRow(value: string, width: number): string {
  return `│${cell(value, width)}│`;
}
