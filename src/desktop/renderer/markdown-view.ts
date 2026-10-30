/// <reference lib="DOM" />

/**
 * Builds DOM for the markdown tree produced by `src/ui/shared/markdown.ts`.
 *
 * Every value reaches the document through `textContent` or a Text node — the
 * desktop renderer never uses `innerHTML`. Local paths use an explicit main
 * process IPC action; navigation remains blocked.
 */

import {
  parseMarkdown,
  type MarkdownAlignment,
  type MarkdownBlock,
  type MarkdownInline,
  type MarkdownListItem,
} from "../../ui/shared/markdown.js";
import { blockKeysOf, commonBlockPrefix } from "../../ui/shared/markdown-stream.js";
import { localTextParts } from "../../ui/shared/local-links.js";

const ALIGNMENT_CLASS: Record<Exclude<MarkdownAlignment, undefined>, string> = {
  left: "md-align-left",
  center: "md-align-center",
  right: "md-align-right",
};

/** Renders `source` as markdown into `container`, replacing nothing that is already there. */
export function appendMarkdown(container: HTMLElement, source: string): void {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) {
    container.append(document.createTextNode(source));
    return;
  }
  for (const block of blocks) container.append(renderBlock(block));
}

/**
 * The streaming bubble needs its caret to sit at the end of the last rendered
 * line rather than on a line of its own, so it is appended inside the trailing
 * block whenever that block is normal prose.
 */
export function appendMarkdownWithTrailing(container: HTMLElement, source: string, trailing: HTMLElement): void {
  appendMarkdown(container, source);
  const last = container.lastElementChild;
  if (last && (last.tagName === "P" || last.classList.contains("md-h"))) last.append(trailing);
  else container.append(trailing);
}

/**
 * A markdown body that can be re-rendered from a growing source without
 * discarding the part that did not change.
 *
 * `appendMarkdown` builds the whole body at once, which is right for a message
 * that is already complete. A streaming reply is re-rendered on every token,
 * and replacing the DOM each time collapses any selection the reader is holding
 * — so text they can already see is text they cannot copy until the reply ends.
 * This keeps the blocks whose parse is unchanged and rebuilds only the tail.
 */
export interface MarkdownSurface {
  update(source: string, trailing?: HTMLElement): void;
}

export function createMarkdownSurface(container: HTMLElement): MarkdownSurface {
  let keys: string[] = [];
  let rendered: HTMLElement[] = [];
  return {
    update(source: string, trailing?: HTMLElement): void {
      const blocks = parseMarkdown(source);
      const next = blockKeysOf(blocks);
      const shared = commonBlockPrefix(keys, next);
      // Detached first: the caret lives inside the last block, which is the one
      // block a token almost always rebuilds.
      trailing?.remove();
      for (let index = shared; index < rendered.length; index += 1) rendered[index]?.remove();
      rendered = rendered.slice(0, shared);
      for (let index = shared; index < blocks.length; index += 1) {
        const block = blocks[index];
        if (!block) continue;
        const node = renderBlock(block);
        container.append(node);
        rendered.push(node);
      }
      keys = next;
      if (!trailing) return;
      const last = rendered.at(-1);
      if (last && (last.tagName === "P" || last.classList.contains("md-h"))) last.append(trailing);
      else container.append(trailing);
    },
  };
}

function renderBlock(block: MarkdownBlock): HTMLElement {
  switch (block.kind) {
    case "paragraph": {
      const paragraph = element("p", "md-p");
      appendInline(paragraph, block.inline);
      return paragraph;
    }
    case "heading": {
      const heading = element(`h${block.level}`, `md-h md-h${block.level}`);
      appendInline(heading, block.inline);
      return heading;
    }
    case "code":
      return renderCode(block);
    case "quote": {
      const quote = element("blockquote", "md-quote");
      for (const child of block.blocks) quote.append(renderBlock(child));
      return quote;
    }
    case "list":
      return renderList(block);
    case "rule":
      return element("hr", "md-rule");
    case "table":
      return renderTable(block);
  }
}

function renderCode(block: Extract<MarkdownBlock, { kind: "code" }>): HTMLElement {
  const figure = element("figure", "md-code");
  const bar = element("figcaption", "md-code-bar");
  const language = element("span", "md-code-lang");
  language.textContent = block.language || "text";
  bar.append(language);
  bar.append(copyButton(block.value));
  const pre = element("pre");
  const code = element("code");
  code.textContent = block.value;
  pre.append(code);
  figure.append(bar, pre);
  if (!block.closed) figure.classList.add("streaming");
  return figure;
}

function copyButton(value: string): HTMLButtonElement {
  const button = element("button", "md-copy") as HTMLButtonElement;
  button.type = "button";
  button.textContent = "复制";
  button.addEventListener("click", () => {
    void copyText(value).then((copied) => {
      button.textContent = copied ? "已复制" : "复制失败";
      globalThis.setTimeout(() => {
        button.textContent = "复制";
      }, 1_600);
    });
  });
  return button;
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // The sandboxed renderer denies permission prompts, so fall back to the
    // selection-based copy path, which needs no permission inside a click.
    const carrier = element("textarea") as HTMLTextAreaElement;
    carrier.value = value;
    carrier.setAttribute("aria-hidden", "true");
    carrier.classList.add("md-copy-carrier");
    document.body.append(carrier);
    carrier.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      carrier.remove();
    }
  }
}

function renderList(block: Extract<MarkdownBlock, { kind: "list" }>): HTMLElement {
  const list = element(block.ordered ? "ol" : "ul", `md-list${block.ordered ? " ordered" : ""}`);
  if (block.ordered && block.start !== 1) (list as HTMLOListElement).start = block.start;
  for (const item of block.items) list.append(renderListItem(item));
  return list;
}

function renderListItem(item: MarkdownListItem): HTMLElement {
  const entry = element("li");
  if (item.checked !== undefined) {
    entry.classList.add("md-task");
    const box = element("span", `md-check${item.checked ? " checked" : ""}`);
    box.setAttribute("role", "img");
    box.setAttribute("aria-label", item.checked ? "已完成" : "未完成");
    box.textContent = item.checked ? "✓" : "";
    entry.append(box);
  }
  const [first, ...rest] = item.blocks;
  // A single leading paragraph stays inline with the marker instead of forcing a block break.
  if (first?.kind === "paragraph") appendInline(entry, first.inline);
  else if (first) entry.append(renderBlock(first));
  for (const block of rest) entry.append(renderBlock(block));
  return entry;
}

function renderTable(block: Extract<MarkdownBlock, { kind: "table" }>): HTMLElement {
  const wrap = element("div", "md-table-wrap");
  const table = element("table", "md-table");
  const head = element("thead");
  const headRow = element("tr");
  block.head.forEach((cell, column) => {
    const heading = element("th", alignmentClass(block.alignments[column]));
    appendInline(heading, cell);
    headRow.append(heading);
  });
  head.append(headRow);
  const body = element("tbody");
  for (const row of block.rows) {
    const line = element("tr");
    row.forEach((cell, column) => {
      const entry = element("td", alignmentClass(block.alignments[column]));
      appendInline(entry, cell);
      line.append(entry);
    });
    body.append(line);
  }
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

function alignmentClass(alignment: MarkdownAlignment): string {
  return alignment ? ALIGNMENT_CLASS[alignment] : "";
}

function appendInline(container: HTMLElement, nodes: readonly MarkdownInline[], linkifyText = true): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        for (const part of linkifyText ? localTextParts(node.value) : [{ text: node.value }]) {
          if (!part.href) {
            container.append(document.createTextNode(part.text));
            continue;
          }
          mountLocalPath(container, part.href, (button) => {
            button.textContent = part.text;
          });
        }
        break;
      case "break":
        container.append(element("br"));
        break;
      case "code": {
        const local = node.value.startsWith("/") || node.value.startsWith("file:///");
        if (local) {
          mountLocalPath(container, node.value, (button) => {
            button.classList.add("md-code-span");
            button.textContent = node.value;
          });
          break;
        }
        const code = element("code", "md-code-span");
        code.textContent = node.value;
        container.append(code);
        break;
      }
      case "strong": {
        const strong = element("strong");
        appendInline(strong, node.children, linkifyText);
        container.append(strong);
        break;
      }
      case "emphasis": {
        const emphasis = element("em");
        appendInline(emphasis, node.children, linkifyText);
        container.append(emphasis);
        break;
      }
      case "strike": {
        const strike = element("s");
        appendInline(strike, node.children, linkifyText);
        container.append(strike);
        break;
      }
      case "link": {
        const local = node.href.startsWith("/") || node.href.startsWith("file:");
        if (local) {
          mountLocalPath(container, node.href, (button) => {
            button.title = node.href;
            appendInline(button, node.children, false);
            button.setAttribute("aria-label", `打开 ${button.textContent || node.href}`);
          });
          break;
        }
        const label = element("span", "md-link");
        label.title = node.href;
        appendInline(label, node.children, false);
        container.append(label);
        if (label.textContent !== node.href) {
          const destination = element("span", "md-link-url");
          destination.textContent = node.href;
          container.append(destination);
        }
        break;
      }
    }
  }
}

function mountLocalPath(container: HTMLElement, href: string, prepare: (button: HTMLButtonElement) => void): void {
  const button = localPathButton(href);
  prepare(button);
  container.append(button, revealButton(button, href));
}

function localPathButton(href: string): HTMLButtonElement {
  const button = element("button", "md-link md-local-link") as HTMLButtonElement;
  button.type = "button";
  button.title = href;
  button.setAttribute("aria-label", `打开 ${href}`);
  button.addEventListener("click", () => {
    void openLinkedPath(button, href, "open");
  });
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showLocalLinkMenu(button, href, event.clientX, event.clientY);
  });
  return button;
}

/** A folder mark sitting on the link, for the same “show this file in its folder” action as the menu. */
function revealButton(link: HTMLButtonElement, href: string): HTMLButtonElement {
  const button = element("button", "md-local-reveal") as HTMLButtonElement;
  button.type = "button";
  button.title = "打开所在目录";
  button.setAttribute("aria-label", "打开所在目录");
  button.append(folderIcon());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openLinkedPath(link, href, "reveal");
  });
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showLocalLinkMenu(link, href, event.clientX, event.clientY);
  });
  return button;
}

function folderIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z");
  svg.append(path);
  return svg;
}

function openLinkedPath(button: HTMLButtonElement, href: string, action: "open" | "reveal"): void {
  closeLocalLinkMenu();
  const reveal = button.nextElementSibling instanceof HTMLButtonElement && button.nextElementSibling.classList.contains("md-local-reveal")
    ? button.nextElementSibling
    : undefined;
  const anchor = reveal ?? button;
  const pending = anchor.nextElementSibling;
  if (pending?.classList.contains("md-link-error")) pending.remove();
  button.disabled = true;
  if (reveal) reveal.disabled = true;
  void window.pspore.openLocalPath({ path: href, action }).then(() => {
    button.disabled = false;
    if (reveal) reveal.disabled = false;
  }, (error: unknown) => {
    button.disabled = false;
    if (reveal) reveal.disabled = false;
    const notice = element("span", "md-link-error");
    notice.setAttribute("role", "status");
    notice.textContent = localOpenError(error);
    anchor.after(notice);
    globalThis.setTimeout(() => notice.remove(), 5_000);
  });
}

function localOpenError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const marker = "Error: ";
  const index = message.lastIndexOf(marker);
  const text = (index >= 0 ? message.slice(index + marker.length) : message).trim();
  return text || "无法打开文件或目录";
}

let localLinkMenu: HTMLDivElement | undefined;
let menuDismiss: ((event: Event) => void) | undefined;

function showLocalLinkMenu(button: HTMLButtonElement, href: string, x: number, y: number): void {
  closeLocalLinkMenu();
  const menu = document.createElement("div");
  menu.className = "local-link-menu";
  menu.setAttribute("role", "menu");
  menu.append(
    localLinkMenuItem("打开", "open", () => openLinkedPath(button, href, "open")),
    localLinkMenuItem("打开所在目录", "reveal", () => openLinkedPath(button, href, "reveal")),
  );
  document.body.append(menu);
  localLinkMenu = menu;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
  menuDismiss = (event: Event) => {
    if (event.type === "keydown" && event instanceof KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeLocalLinkMenu();
        button.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "ArrowDown" ? current + 1 : current - 1;
        items[(next + items.length) % items.length]?.focus();
      }
      return;
    }
    if (event.target instanceof Node && menu.contains(event.target)) return;
    closeLocalLinkMenu();
  };
  document.addEventListener("pointerdown", menuDismiss, true);
  document.addEventListener("keydown", menuDismiss, true);
  document.addEventListener("scroll", menuDismiss, true);
  menu.querySelector<HTMLButtonElement>("[data-action=open]")?.focus();
}

function localLinkMenuItem(label: string, action: "open" | "reveal", command: () => void): HTMLButtonElement {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "local-link-menu-item";
  item.dataset["action"] = action;
  item.setAttribute("role", "menuitem");
  item.textContent = label;
  item.addEventListener("click", (event) => {
    event.preventDefault();
    command();
  });
  return item;
}

function closeLocalLinkMenu(): void {
  if (menuDismiss) {
    document.removeEventListener("pointerdown", menuDismiss, true);
    document.removeEventListener("keydown", menuDismiss, true);
    document.removeEventListener("scroll", menuDismiss, true);
    menuDismiss = undefined;
  }
  localLinkMenu?.remove();
  localLinkMenu = undefined;
}

function element(tag: string, className?: string): HTMLElement {
  const created = document.createElement(tag);
  if (className) created.className = className;
  return created;
}
