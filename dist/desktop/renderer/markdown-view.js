/// <reference lib="DOM" />
/**
 * Builds DOM for the markdown tree produced by `src/ui/shared/markdown.ts`.
 *
 * Every value reaches the document through `textContent` or a Text node — the
 * desktop renderer never uses `innerHTML`, and link destinations are rendered as
 * inert text because the main process blocks all external navigation.
 */
import { parseMarkdown, } from "../../ui/shared/markdown.js";
const ALIGNMENT_CLASS = {
    left: "md-align-left",
    center: "md-align-center",
    right: "md-align-right",
};
/** Renders `source` as markdown into `container`, replacing nothing that is already there. */
export function appendMarkdown(container, source) {
    const blocks = parseMarkdown(source);
    if (blocks.length === 0) {
        container.append(document.createTextNode(source));
        return;
    }
    for (const block of blocks)
        container.append(renderBlock(block));
}
/**
 * The streaming bubble needs its caret to sit at the end of the last rendered
 * line rather than on a line of its own, so it is appended inside the trailing
 * block whenever that block is normal prose.
 */
export function appendMarkdownWithTrailing(container, source, trailing) {
    appendMarkdown(container, source);
    const last = container.lastElementChild;
    if (last && (last.tagName === "P" || last.classList.contains("md-h")))
        last.append(trailing);
    else
        container.append(trailing);
}
function renderBlock(block) {
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
            for (const child of block.blocks)
                quote.append(renderBlock(child));
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
function renderCode(block) {
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
    if (!block.closed)
        figure.classList.add("streaming");
    return figure;
}
function copyButton(value) {
    const button = element("button", "md-copy");
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
async function copyText(value) {
    try {
        await navigator.clipboard.writeText(value);
        return true;
    }
    catch {
        // The sandboxed renderer denies permission prompts, so fall back to the
        // selection-based copy path, which needs no permission inside a click.
        const carrier = element("textarea");
        carrier.value = value;
        carrier.setAttribute("aria-hidden", "true");
        carrier.classList.add("md-copy-carrier");
        document.body.append(carrier);
        carrier.select();
        try {
            return document.execCommand("copy");
        }
        catch {
            return false;
        }
        finally {
            carrier.remove();
        }
    }
}
function renderList(block) {
    const list = element(block.ordered ? "ol" : "ul", `md-list${block.ordered ? " ordered" : ""}`);
    if (block.ordered && block.start !== 1)
        list.start = block.start;
    for (const item of block.items)
        list.append(renderListItem(item));
    return list;
}
function renderListItem(item) {
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
    if (first?.kind === "paragraph")
        appendInline(entry, first.inline);
    else if (first)
        entry.append(renderBlock(first));
    for (const block of rest)
        entry.append(renderBlock(block));
    return entry;
}
function renderTable(block) {
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
function alignmentClass(alignment) {
    return alignment ? ALIGNMENT_CLASS[alignment] : "";
}
function appendInline(container, nodes) {
    for (const node of nodes) {
        switch (node.kind) {
            case "text":
                container.append(document.createTextNode(node.value));
                break;
            case "break":
                container.append(element("br"));
                break;
            case "code": {
                const code = element("code", "md-code-span");
                code.textContent = node.value;
                container.append(code);
                break;
            }
            case "strong": {
                const strong = element("strong");
                appendInline(strong, node.children);
                container.append(strong);
                break;
            }
            case "emphasis": {
                const emphasis = element("em");
                appendInline(emphasis, node.children);
                container.append(emphasis);
                break;
            }
            case "strike": {
                const strike = element("s");
                appendInline(strike, node.children);
                container.append(strike);
                break;
            }
            case "link": {
                // Rendered inert: the desktop client blocks external navigation, so the
                // destination is shown as copyable text instead of a dead hyperlink.
                const label = element("span", "md-link");
                label.title = node.href;
                appendInline(label, node.children);
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
function element(tag, className) {
    const created = document.createElement(tag);
    if (className)
        created.className = className;
    return created;
}
//# sourceMappingURL=markdown-view.js.map