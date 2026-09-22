/**
 * Markdown to plain text for the `.txt` export.
 *
 * Markers (`#`, `**`, backticks, table pipes) are dropped. The words stay, in
 * reading order, so the file is something a person can open without a renderer.
 */
import { parseMarkdown, } from "../ui/shared/markdown.js";
export function markdownToPlainText(source) {
    const normalized = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const blocks = parseMarkdown(normalized);
    if (blocks.length === 0)
        return normalized.trim();
    return blocks.map((block) => blockToPlain(block).trimEnd()).filter((part) => part !== "").join("\n\n");
}
function blockToPlain(block) {
    switch (block.kind) {
        case "paragraph":
            return inlineToPlain(block.inline);
        case "heading":
            return inlineToPlain(block.inline);
        case "code":
            return block.value;
        case "quote":
            return block.blocks.map((child) => blockToPlain(child)).filter(Boolean).join("\n");
        case "list":
            return block.items.map((item, index) => listItemToPlain(item.blocks, block.ordered, block.start + index, item.checked)).join("\n");
        case "rule":
            return "";
        case "table": {
            const rows = [block.head, ...block.rows];
            return rows.map((row) => row.map((cell) => inlineToPlain(cell).replaceAll("\t", " ")).join("\t")).join("\n");
        }
    }
}
function listItemToPlain(blocks, ordered, number, checked) {
    const text = blocks.map((block) => blockToPlain(block)).filter(Boolean).join("\n");
    const mark = checked === undefined ? "" : checked ? "已完成 " : "未完成 ";
    const prefix = ordered ? `${number}. ` : "• ";
    return `${prefix}${mark}${text}`;
}
function inlineToPlain(inline) {
    return inline.map((part) => inlinePart(part)).join("");
}
function inlinePart(part) {
    switch (part.kind) {
        case "text":
        case "code":
            return part.value;
        case "strong":
        case "emphasis":
        case "strike":
            return inlineToPlain(part.children);
        case "link": {
            const label = inlineToPlain(part.children);
            return label === part.href || label === "" ? part.href : `${label} (${part.href})`;
        }
        case "break":
            return "\n";
    }
}
//# sourceMappingURL=plain.js.map