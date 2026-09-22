/**
 * Markdown to plain text for the `.txt` export.
 *
 * Markers (`#`, `**`, backticks, table pipes) are dropped. The words stay, in
 * reading order, so the file is something a person can open without a renderer.
 */

import {
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from "../ui/shared/markdown.js";

export function markdownToPlainText(source: string): string {
  const normalized = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const blocks = parseMarkdown(normalized);
  if (blocks.length === 0) return normalized.trim();
  return blocks.map((block) => blockToPlain(block).trimEnd()).filter((part) => part !== "").join("\n\n");
}

function blockToPlain(block: MarkdownBlock): string {
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

/** Two spaces per level, so a nested list reads as nested without any markers. */
const LIST_INDENT = "  ";

function listItemToPlain(
  blocks: readonly MarkdownBlock[],
  ordered: boolean,
  number: number,
  checked: boolean | undefined,
): string {
  const head = blocks[0];
  const lead = head?.kind === "paragraph" ? inlineToPlain(head.inline) : "";
  const rest = blocks.slice(head?.kind === "paragraph" ? 1 : 0)
    .map((block) => blockToPlain(block))
    .filter(Boolean)
    .map((text) => text.split("\n").map((line) => `${LIST_INDENT}${line}`).join("\n"))
    .join("\n");
  const mark = checked === undefined ? "" : checked ? "已完成 " : "未完成 ";
  const prefix = ordered ? `${number}. ` : "• ";
  return rest ? `${prefix}${mark}${lead}\n${rest}` : `${prefix}${mark}${lead}`;
}

function inlineToPlain(inline: readonly MarkdownInline[]): string {
  return inline.map((part) => inlinePart(part)).join("");
}

function inlinePart(part: MarkdownInline): string {
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
