import type { RuntimeCompaction } from "../../domain/runtime.js";
import { formatTokens } from "../../ui/shared/presentation.js";
import { formatElapsed } from "./indexing-view.js";
import { revealPanel } from "./motion.js";
import { t } from "./i18n.js";

const SUCCESS_VISIBLE_MS = 8_000;

/**
 * Pi refuses a manual compaction that has nothing to summarize. That is a
 * quiet "not needed yet", not an error the user has to act on.
 */
export function compactionNotNeeded(state: RuntimeCompaction | undefined): "small" | "recent" | undefined {
  if (state?.status !== "failed" || !state.error) return undefined;
  if (/Nothing to compact/i.test(state.error)) return "small";
  return /Already compacted/i.test(state.error) ? "recent" : undefined;
}

/** The model reports no measurable intermediate percentage; never invent one. */
export class CompactionPanel {
  readonly #root: HTMLElement;
  readonly #title = node("strong", "compaction-title");
  readonly #detail = node("p", "compaction-detail");
  readonly #elapsed = node("span", "compaction-elapsed");
  readonly #bar = node("div", "compaction-track");
  readonly #steps = node("div", "compaction-steps");
  readonly #dismiss = node("button", "compaction-dismiss ghost-button");
  #current: RuntimeCompaction | undefined;
  #key = "";
  #dismissed = new Set<string>();
  #timer: number | undefined;

  constructor(root: HTMLElement) {
    this.#root = root;
    const mark = node("div", "compaction-mark");
    mark.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 3; index++) mark.append(node("i", "compaction-sheet"));
    const copy = node("div", "compaction-copy");
    this.#title.setAttribute("role", "status");
    this.#title.setAttribute("aria-live", "polite");
    copy.append(this.#title, this.#detail);
    const header = node("div", "compaction-heading");
    this.#dismiss.type = "button";
    this.#dismiss.textContent = "×";
    this.#dismiss.setAttribute("aria-label", t("收起压缩结果"));
    this.#dismiss.addEventListener("click", () => {
      if (this.#key) this.#dismissed.add(this.#key);
      this.#hide();
      document.getElementById("compact-button")?.focus();
    });
    header.append(mark, copy, this.#elapsed, this.#dismiss);
    this.#bar.setAttribute("role", "progressbar");
    this.#bar.setAttribute("aria-label", t("上下文压缩进度"));
    this.#bar.append(node("span", "compaction-fill"));
    root.append(header, this.#bar, this.#steps);
  }

  render(sessionId: string, state: RuntimeCompaction | undefined): void {
    const key = state ? `${sessionId}:${state.id}` : "";
    const changed = key !== this.#key || state?.status !== this.#current?.status;
    this.#key = key;
    this.#current = state;
    if (!state || this.#dismissed.has(key) || this.#expired(state)) {
      this.#hide();
      return;
    }
    const reveal = this.#root.hidden || changed;
    this.#root.hidden = false;
    this.#root.dataset["status"] = state.status;
    const notNeeded = compactionNotNeeded(state);
    if (notNeeded) this.#root.dataset["tone"] = "quiet";
    else delete this.#root.dataset["tone"];
    const running = state.status === "running";
    this.#bar.setAttribute("aria-busy", String(running));
    this.#dismiss.hidden = running;
    this.#title.textContent = running ? t("正在压缩上下文")
      : state.status === "succeeded" ? t("上下文已精简")
        : state.status === "aborted" ? t("压缩已停止") : notNeeded ? t("暂时无需压缩") : t("上下文压缩失败");
    this.#detail.textContent = running
      ? t("正在生成摘要，保留关键进展与最近消息")
      : state.status === "succeeded" && state.tokensBefore !== undefined && state.tokensAfter !== undefined
        ? t("{before} → ≈{after} tokens · 完整聊天记录仍可查看", { before: formatTokens(state.tokensBefore), after: formatTokens(state.tokensAfter) })
        : notNeeded === "small" ? t("会话内容还不多，保留完整上下文即可")
          : notNeeded === "recent" ? t("上下文刚刚精简过，新的对话积累后再压缩")
            : state.error ?? t("原始聊天记录已保留");
    this.#detail.title = this.#detail.textContent;
    this.#bar.removeAttribute("aria-valuenow");
    this.#bar.setAttribute("aria-valuetext", running ? t("正在生成摘要，进度未知") : this.#title.textContent);
    if (state.status === "succeeded") this.#bar.setAttribute("aria-valuenow", "100");
    if (changed) {
      const labels = [t("整理上下文"), t("生成摘要"), t("准备就绪")];
      this.#steps.replaceChildren(...labels.map((label, index) => {
        const step = node("span", "compaction-step");
        const done = state.status === "succeeded" || (running && index === 0);
        step.dataset["state"] = done ? "done" : running && index === 1 ? "active" : "pending";
        const badge = node("i", "compaction-step-index");
        badge.setAttribute("aria-hidden", "true");
        badge.textContent = done ? "✓" : String(index + 1);
        const text = node("span", "compaction-step-label");
        text.textContent = label;
        step.append(badge, text);
        return step;
      }));
    }
    this.#tick();
    if (this.#timer === undefined && (running || state.status === "succeeded")) {
      this.#timer = window.setInterval(() => this.#tick(), 1_000);
    } else if (!running && state.status !== "succeeded") this.#stopTimer();
    if (reveal) revealPanel(this.#root);
  }

  #expired(state: RuntimeCompaction): boolean {
    return state.status === "succeeded" && state.completedAt !== undefined
      && Date.now() - Date.parse(state.completedAt) >= SUCCESS_VISIBLE_MS;
  }

  #tick(): void {
    const state = this.#current;
    if (!state || this.#expired(state)) { this.#hide(); return; }
    const end = state.completedAt ? Date.parse(state.completedAt) : Date.now();
    const seconds = Math.max(0, Math.floor((end - Date.parse(state.startedAt)) / 1_000));
    this.#elapsed.textContent = Number.isFinite(seconds) ? formatElapsed(seconds) : "";
    if (state.status === "running" && seconds >= 30) {
      this.#detail.textContent = t("仍在等待模型生成摘要，耗时取决于上下文长度与模型响应");
    }
  }

  #stopTimer(): void {
    if (this.#timer !== undefined) window.clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #hide(): void {
    this.#root.hidden = true;
    this.#stopTimer();
  }
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}
