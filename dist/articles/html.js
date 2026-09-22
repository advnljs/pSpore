/**
 * Markdown to a self-contained HTML document for print-to-PDF.
 *
 * The hidden export window loads this file with JavaScript disabled. Every
 * piece of article text is escaped, and link targets are limited to http(s)
 * and mailto so a model-written document cannot navigate that window.
 */
import { parseMarkdown, } from "../ui/shared/markdown.js";
const FONT = `"Noto Sans CJK SC","Noto Sans CJK","Source Han Sans SC","WenQuanYi Micro Hei","Microsoft YaHei","PingFang SC",sans-serif`;
const MONO = `"Noto Sans Mono CJK SC","Sarasa Mono SC","DejaVu Sans Mono",ui-monospace,monospace`;
export function markdownToPdfHtml(source, title) {
    const body = parseMarkdown(source).map((block) => blockToHtml(block)).join("\n");
    const safeTitle = escapeHtml(title.trim() || "文稿");
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${safeTitle}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  html, body { margin: 0; padding: 0; }
  body { color: #1c1917; background: #fff; font: 15px/1.75 ${FONT}; }
  h1, h2, h3, h4, h5, h6 { font-weight: 700; line-height: 1.35; margin: 1.4em 0 0.45em; }
  h1 { font-size: 26px; }
  h2 { font-size: 21px; }
  h3 { font-size: 18px; }
  h4, h5, h6 { font-size: 16px; }
  p { margin: 0.7em 0; }
  a { color: #1d4e89; }
  blockquote { margin: 0.8em 0; padding: 0.2em 0 0.2em 0.9em; border-left: 3px solid #d6d3d1; color: #44403c; }
  ul, ol { margin: 0.6em 0; padding-left: 1.4em; }
  li { margin: 0.2em 0; }
  li > p:first-child { margin-top: 0; }
  li > p:last-child { margin-bottom: 0; }
  li > ul, li > ol { margin: 0.2em 0; }
  pre { margin: 0.8em 0; padding: 10px 12px; background: #f5f5f4; border-radius: 6px; white-space: pre-wrap; font: 13px/1.6 ${MONO}; }
  code { font-family: ${MONO}; font-size: 0.92em; background: #f5f5f4; padding: 0 0.2em; border-radius: 3px; }
  pre code { background: transparent; padding: 0; }
  table { width: 100%; border-collapse: collapse; margin: 0.8em 0; }
  th, td { border: 1px solid #d6d3d1; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #fafaf9; }
  hr { border: 0; border-top: 1px solid #d6d3d1; margin: 1.4em 0; }
</style>
</head>
<body>
${body || "<p></p>"}
</body>
</html>
`;
}
function blockToHtml(block) {
    switch (block.kind) {
        case "paragraph":
            return `<p>${inlineToHtml(block.inline)}</p>`;
        case "heading":
            return `<h${block.level}>${inlineToHtml(block.inline)}</h${block.level}>`;
        case "code":
            return `<pre><code>${escapeHtml(block.value)}</code></pre>`;
        case "quote":
            return `<blockquote>${block.blocks.map((child) => blockToHtml(child)).join("\n")}</blockquote>`;
        case "list": {
            const tag = block.ordered ? "ol" : "ul";
            const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
            const items = block.items.map((item) => {
                const head = item.blocks[0];
                const mark = item.checked === undefined ? "" : item.checked ? "☑ " : "☐ ";
                // An item's own sentence goes straight into the <li>. Wrapping it in a
                // block would put the checkbox on one line and the words on the next,
                // and give every item a paragraph's worth of air around it.
                const lead = head?.kind === "paragraph" ? `${mark}${inlineToHtml(head.inline)}` : mark;
                const rest = item.blocks.slice(head?.kind === "paragraph" ? 1 : 0).map((child) => blockToHtml(child)).join("");
                return `<li>${lead}${rest}</li>`;
            }).join("");
            return `<${tag}${start}>${items}</${tag}>`;
        }
        case "rule":
            return "<hr />";
        case "table": {
            const head = `<tr>${block.head.map((cell) => `<th>${inlineToHtml(cell)}</th>`).join("")}</tr>`;
            const rows = block.rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineToHtml(cell)}</td>`).join("")}</tr>`).join("");
            return `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`;
        }
    }
}
function inlineToHtml(inline) {
    return inline.map((part) => inlinePart(part)).join("");
}
function inlinePart(part) {
    switch (part.kind) {
        case "text":
            return escapeHtml(part.value);
        case "code":
            return `<code>${escapeHtml(part.value)}</code>`;
        case "strong":
            return `<strong>${inlineToHtml(part.children)}</strong>`;
        case "emphasis":
            return `<em>${inlineToHtml(part.children)}</em>`;
        case "strike":
            return `<s>${inlineToHtml(part.children)}</s>`;
        case "link": {
            const label = inlineToHtml(part.children) || escapeHtml(part.href);
            const href = safeHref(part.href);
            return href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
        }
        case "break":
            return "<br />";
    }
}
function safeHref(value) {
    const href = value.trim();
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href))
        return href;
    return undefined;
}
export function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
//# sourceMappingURL=html.js.map