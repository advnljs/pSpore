/**
 * Minimal CommonMark/GFM subset parser shared by the desktop renderer.
 *
 * It produces a plain data tree so the renderer can build DOM nodes with
 * `document.createElement`/`textContent` only — the desktop client never uses
 * `innerHTML`, so markdown must never round-trip through an HTML string.
 *
 * Supported: ATX headings, fenced code (including the still-open fence that
 * streaming produces), blockquotes, ordered/unordered/task lists, thematic
 * breaks, GFM pipe tables, and inline code/strong/emphasis/strikethrough/links.
 */
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const BULLET = /^([ \t]*)([-*+])[ \t]+(.*)$/;
const ORDERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;
const TASK = /^\[([ xX])\][ \t]+(.*)$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~>]/;
const LINK_SCHEME = /^(?:https?:\/\/|mailto:|file:\/\/|\/)/i;
/** Depth guard: markdown that nests deeper than this is pathological, not prose. */
const MAX_DEPTH = 6;
export function parseMarkdown(source, depth = 0) {
    const lines = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    const blocks = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index] ?? "";
        if (line.trim() === "") {
            index += 1;
            continue;
        }
        const fence = FENCE.exec(line);
        if (fence) {
            const marker = fence[1] ?? "```";
            const body = [];
            let closed = false;
            index += 1;
            while (index < lines.length) {
                const candidate = lines[index] ?? "";
                if (isClosingFence(candidate, marker)) {
                    closed = true;
                    index += 1;
                    break;
                }
                body.push(candidate);
                index += 1;
            }
            blocks.push({ kind: "code", language: (fence[2] ?? "").trim(), value: body.join("\n"), closed });
            continue;
        }
        const heading = HEADING.exec(line);
        if (heading) {
            const level = Math.min(6, Math.max(1, (heading[1] ?? "#").length));
            blocks.push({ kind: "heading", level, inline: parseInline(heading[2] ?? "") });
            index += 1;
            continue;
        }
        if (RULE.test(line)) {
            blocks.push({ kind: "rule" });
            index += 1;
            continue;
        }
        if (QUOTE.test(line)) {
            const quoted = [];
            while (index < lines.length) {
                const candidate = lines[index] ?? "";
                if (QUOTE.test(candidate)) {
                    quoted.push(candidate.replace(QUOTE, ""));
                    index += 1;
                    continue;
                }
                // Lazy continuation: a plain line right after `>` stays inside the quote.
                if (candidate.trim() === "" || startsBlock(candidate))
                    break;
                quoted.push(candidate);
                index += 1;
            }
            blocks.push({
                kind: "quote",
                blocks: depth >= MAX_DEPTH ? [{ kind: "paragraph", inline: parseInline(quoted.join("\n")) }] : parseMarkdown(quoted.join("\n"), depth + 1),
            });
            continue;
        }
        const table = parseTable(lines, index);
        if (table) {
            blocks.push(table.block);
            index = table.next;
            continue;
        }
        if (BULLET.test(line) || ORDERED.test(line)) {
            const list = parseList(lines, index, depth);
            blocks.push(list.block);
            index = list.next;
            continue;
        }
        const paragraph = [];
        while (index < lines.length) {
            const candidate = lines[index] ?? "";
            if (candidate.trim() === "" || startsBlock(candidate))
                break;
            paragraph.push(candidate.trim());
            index += 1;
        }
        if (paragraph.length > 0)
            blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join("\n")) });
    }
    return blocks;
}
function isClosingFence(line, marker) {
    const trimmed = line.trim();
    const character = marker[0] ?? "`";
    return trimmed.length >= marker.length && [...trimmed].every((entry) => entry === character);
}
/** A line that would open a different block, so a paragraph or quote must stop before it. */
function startsBlock(line) {
    return (FENCE.test(line)
        || HEADING.test(line)
        || RULE.test(line)
        || QUOTE.test(line)
        || BULLET.test(line)
        || ORDERED.test(line));
}
function parseList(lines, start, depth) {
    const first = BULLET.exec(lines[start] ?? "") ?? ORDERED.exec(lines[start] ?? "");
    const ordered = !BULLET.test(lines[start] ?? "");
    const baseIndent = indentWidth(first?.[1] ?? "");
    const items = [];
    let index = start;
    let pendingBlank = false;
    while (index < lines.length) {
        const line = lines[index] ?? "";
        if (line.trim() === "") {
            pendingBlank = true;
            index += 1;
            continue;
        }
        const bullet = BULLET.exec(line);
        const numbered = ORDERED.exec(line);
        const match = ordered ? numbered : bullet;
        const marker = bullet ?? numbered;
        if (!marker)
            break;
        const markerIndent = indentWidth(marker[1] ?? "");
        if (markerIndent < baseIndent)
            break;
        // A same-level marker of the other kind opens a new list rather than continuing this one.
        if (markerIndent === baseIndent && !match)
            break;
        if (!match || indentWidth(match[1] ?? "") !== baseIndent) {
            // A deeper or differently-typed marker belongs to the current item's body.
            if (items.length === 0)
                break;
            index = absorbContinuation(lines, index, baseIndent, items, depth, pendingBlank);
            pendingBlank = false;
            continue;
        }
        if (pendingBlank && items.length > 0)
            pendingBlank = false;
        const content = [];
        const task = TASK.exec(match[3] ?? "");
        content.push(task ? (task[2] ?? "") : (match[3] ?? ""));
        index += 1;
        while (index < lines.length) {
            const candidate = lines[index] ?? "";
            if (candidate.trim() === "") {
                // A blank line only continues the item when an indented line follows it.
                const following = lines[index + 1] ?? "";
                if (following.trim() !== "" && indentWidth(leadingWhitespace(following)) > baseIndent) {
                    content.push("");
                    index += 1;
                    continue;
                }
                break;
            }
            if (indentWidth(leadingWhitespace(candidate)) <= baseIndent && startsBlock(candidate))
                break;
            content.push(candidate.replace(new RegExp(`^[ \\t]{0,${baseIndent + 4}}`), ""));
            index += 1;
        }
        const body = content.join("\n");
        items.push({
            ...(task ? { checked: (task[1] ?? " ").toLowerCase() === "x" } : {}),
            blocks: depth >= MAX_DEPTH
                ? [{ kind: "paragraph", inline: parseInline(body) }]
                : parseMarkdown(body, depth + 1),
        });
    }
    return {
        block: {
            kind: "list",
            ordered,
            start: ordered ? Number.parseInt(first?.[2] ?? "1", 10) || 1 : 1,
            items,
        },
        next: index,
    };
}
/** Folds an over-indented marker line (a nested list) into the previous item. */
function absorbContinuation(lines, start, baseIndent, items, depth, pendingBlank) {
    const previous = items[items.length - 1];
    if (!previous)
        return start + 1;
    const nested = pendingBlank ? [""] : [];
    let index = start;
    while (index < lines.length) {
        const candidate = lines[index] ?? "";
        if (candidate.trim() === "") {
            const following = lines[index + 1] ?? "";
            if (following.trim() === "" || indentWidth(leadingWhitespace(following)) <= baseIndent)
                break;
            nested.push("");
            index += 1;
            continue;
        }
        if (indentWidth(leadingWhitespace(candidate)) <= baseIndent)
            break;
        nested.push(candidate.replace(new RegExp(`^[ \\t]{0,${baseIndent + 4}}`), ""));
        index += 1;
    }
    if (nested.length === 0)
        return start + 1;
    const merged = [...previous.blocks];
    const parsed = depth >= MAX_DEPTH
        ? [{ kind: "paragraph", inline: parseInline(nested.join("\n")) }]
        : parseMarkdown(nested.join("\n"), depth + 1);
    previous.blocks = [...merged, ...parsed];
    return index;
}
function parseTable(lines, start) {
    const header = lines[start] ?? "";
    const delimiter = lines[start + 1];
    if (!header.includes("|") || delimiter === undefined || !TABLE_DELIMITER.test(delimiter))
        return undefined;
    const head = splitRow(header);
    const alignments = splitRow(delimiter).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right)
            return "center";
        if (right)
            return "right";
        if (left)
            return "left";
        return undefined;
    });
    if (head.length === 0 || head.length !== alignments.length)
        return undefined;
    const rows = [];
    let index = start + 2;
    while (index < lines.length) {
        const line = lines[index] ?? "";
        if (line.trim() === "" || !line.includes("|") || startsBlock(line))
            break;
        const cells = splitRow(line);
        rows.push(Array.from({ length: head.length }, (_unused, column) => parseInline(cells[column] ?? "")));
        index += 1;
    }
    return {
        block: { kind: "table", alignments, head: head.map((cell) => parseInline(cell)), rows },
        next: index,
    };
}
function splitRow(line) {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells = [];
    let buffer = "";
    for (let index = 0; index < trimmed.length; index += 1) {
        const character = trimmed[index];
        if (character === "\\" && trimmed[index + 1] === "|") {
            buffer += "|";
            index += 1;
            continue;
        }
        if (character === "|") {
            cells.push(buffer.trim());
            buffer = "";
            continue;
        }
        buffer += character ?? "";
    }
    cells.push(buffer.trim());
    return cells;
}
export function parseInline(source, depth = 0) {
    const nodes = [];
    let buffer = "";
    let index = 0;
    const flush = () => {
        if (buffer)
            nodes.push({ kind: "text", value: buffer });
        buffer = "";
    };
    while (index < source.length) {
        const character = source[index] ?? "";
        if (character === "\\") {
            const next = source[index + 1] ?? "";
            if (ESCAPABLE.test(next)) {
                buffer += next;
                index += 2;
                continue;
            }
        }
        if (character === "\n") {
            flush();
            nodes.push({ kind: "break" });
            index += 1;
            continue;
        }
        if (character === "`") {
            const run = runLength(source, index, "`");
            const close = source.indexOf("`".repeat(run), index + run);
            if (close >= 0 && runLength(source, close, "`") === run) {
                flush();
                nodes.push({ kind: "code", value: normalizeCodeSpan(source.slice(index + run, close)) });
                index = close + run;
                continue;
            }
        }
        if (character === "[" && depth < MAX_DEPTH) {
            const link = matchLink(source, index);
            if (link) {
                flush();
                nodes.push({ kind: "link", href: link.href, children: parseInline(link.label, depth + 1) });
                index = link.end;
                continue;
            }
        }
        if ((character === "*" || character === "_" || character === "~") && depth < MAX_DEPTH) {
            const emphasis = matchEmphasis(source, index, depth);
            if (emphasis) {
                flush();
                nodes.push(emphasis.node);
                index = emphasis.end;
                continue;
            }
        }
        buffer += character;
        index += 1;
    }
    flush();
    return nodes;
}
function matchLink(source, start) {
    let depth = 0;
    let labelEnd = -1;
    for (let index = start; index < source.length; index += 1) {
        const character = source[index];
        if (character === "\\") {
            index += 1;
            continue;
        }
        if (character === "[")
            depth += 1;
        if (character === "]") {
            depth -= 1;
            if (depth === 0) {
                labelEnd = index;
                break;
            }
        }
        if (character === "\n")
            break;
    }
    if (labelEnd < 0 || source[labelEnd + 1] !== "(")
        return undefined;
    const close = source.indexOf(")", labelEnd + 2);
    if (close < 0)
        return undefined;
    const destination = source.slice(labelEnd + 2, close).trim().split(/\s+/)[0] ?? "";
    const href = destination.replace(/^<|>$/g, "");
    if (!LINK_SCHEME.test(href))
        return undefined;
    return { label: source.slice(start + 1, labelEnd), href, end: close + 1 };
}
function matchEmphasis(source, start, depth) {
    const character = source[start] ?? "";
    const run = runLength(source, start, character);
    const width = character === "~" ? 2 : Math.min(run, 2);
    if (character === "~" && run < 2)
        return undefined;
    const marker = character.repeat(width);
    // `snake_case` must stay literal, so `_` only opens on a word boundary.
    if (character === "_" && isWordCharacter(source[start - 1]))
        return undefined;
    let index = start + width;
    while (index < source.length) {
        const candidate = source[index];
        if (candidate === "\\") {
            index += 2;
            continue;
        }
        if (candidate === character && source.startsWith(marker, index)) {
            const content = source.slice(start + width, index);
            if (content.trim() === "" || /^\s/.test(content) || /\s$/.test(content))
                return undefined;
            if (character === "_" && isWordCharacter(source[index + width])) {
                index += width;
                continue;
            }
            const children = parseInline(content, depth + 1);
            const kind = character === "~" ? "strike" : width === 2 ? "strong" : "emphasis";
            return { node: { kind, children }, end: index + width };
        }
        index += 1;
    }
    return undefined;
}
function normalizeCodeSpan(value) {
    const collapsed = value.replaceAll("\n", " ");
    return collapsed.length > 2 && collapsed.startsWith(" ") && collapsed.endsWith(" ") && collapsed.trim() !== ""
        ? collapsed.slice(1, -1)
        : collapsed;
}
function runLength(source, start, character) {
    let length = 0;
    while (source[start + length] === character)
        length += 1;
    return length;
}
function isWordCharacter(value) {
    return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}
function leadingWhitespace(line) {
    return /^[ \t]*/.exec(line)?.[0] ?? "";
}
function indentWidth(value) {
    let width = 0;
    for (const character of value)
        width += character === "\t" ? 4 : 1;
    return width;
}
//# sourceMappingURL=markdown.js.map