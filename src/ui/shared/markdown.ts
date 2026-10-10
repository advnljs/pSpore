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

export type MarkdownInline =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "strong"; children: MarkdownInline[] }
  | { kind: "emphasis"; children: MarkdownInline[] }
  | { kind: "strike"; children: MarkdownInline[] }
  | { kind: "link"; href: string; children: MarkdownInline[] }
  | { kind: "break" };

export type MarkdownAlignment = "left" | "center" | "right" | undefined;

export interface MarkdownListItem {
  /** `undefined` for a plain bullet, boolean for a `- [ ]` / `- [x]` task item. */
  checked?: boolean;
  blocks: MarkdownBlock[];
}

export type MarkdownBlock =
  | { kind: "paragraph"; inline: MarkdownInline[] }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inline: MarkdownInline[] }
  | { kind: "code"; language: string; value: string; closed: boolean }
  | { kind: "quote"; blocks: MarkdownBlock[] }
  | { kind: "list"; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { kind: "rule" }
  | { kind: "table"; alignments: MarkdownAlignment[]; head: MarkdownInline[][]; rows: MarkdownInline[][][] };

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

export function parseMarkdown(source: string, depth = 0): MarkdownBlock[] {
  const lines = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
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
      const body: string[] = [];
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
      const level = Math.min(6, Math.max(1, (heading[1] ?? "#").length)) as 1 | 2 | 3 | 4 | 5 | 6;
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
      const quoted: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        if (QUOTE.test(candidate)) {
          quoted.push(candidate.replace(QUOTE, ""));
          index += 1;
          continue;
        }
        // Lazy continuation: a plain line right after `>` stays inside the quote.
        if (candidate.trim() === "" || startsBlock(candidate)) break;
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

    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index] ?? "";
      if (candidate.trim() === "" || startsBlock(candidate)) break;
      paragraph.push(candidate.trim());
      index += 1;
    }
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}

function isClosingFence(line: string, marker: string): boolean {
  const trimmed = line.trim();
  const character = marker[0] ?? "`";
  return trimmed.length >= marker.length && [...trimmed].every((entry) => entry === character);
}

/** A line that would open a different block, so a paragraph or quote must stop before it. */
function startsBlock(line: string): boolean {
  return (
    FENCE.test(line)
    || HEADING.test(line)
    || RULE.test(line)
    || QUOTE.test(line)
    || BULLET.test(line)
    || ORDERED.test(line)
  );
}

interface ListParse {
  block: Extract<MarkdownBlock, { kind: "list" }>;
  next: number;
}

function parseList(lines: readonly string[], start: number, depth: number): ListParse {
  const first = BULLET.exec(lines[start] ?? "") ?? ORDERED.exec(lines[start] ?? "");
  const ordered = !BULLET.test(lines[start] ?? "");
  const baseIndent = indentWidth(first?.[1] ?? "");
  const items: MarkdownListItem[] = [];
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
    if (!marker) break;
    const markerIndent = indentWidth(marker[1] ?? "");
    if (markerIndent < baseIndent) break;
    // A same-level marker of the other kind opens a new list rather than continuing this one.
    if (markerIndent === baseIndent && !match) break;
    if (!match || indentWidth(match[1] ?? "") !== baseIndent) {
      // A deeper or differently-typed marker belongs to the current item's body.
      if (items.length === 0) break;
      index = absorbContinuation(lines, index, baseIndent, items, depth, pendingBlank);
      pendingBlank = false;
      continue;
    }
    if (pendingBlank && items.length > 0) pendingBlank = false;

    const content: string[] = [];
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
      if (indentWidth(leadingWhitespace(candidate)) <= baseIndent && startsBlock(candidate)) break;
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
function absorbContinuation(
  lines: readonly string[],
  start: number,
  baseIndent: number,
  items: MarkdownListItem[],
  depth: number,
  pendingBlank: boolean,
): number {
  const previous = items[items.length - 1];
  if (!previous) return start + 1;
  const nested: string[] = pendingBlank ? [""] : [];
  let index = start;
  while (index < lines.length) {
    const candidate = lines[index] ?? "";
    if (candidate.trim() === "") {
      const following = lines[index + 1] ?? "";
      if (following.trim() === "" || indentWidth(leadingWhitespace(following)) <= baseIndent) break;
      nested.push("");
      index += 1;
      continue;
    }
    if (indentWidth(leadingWhitespace(candidate)) <= baseIndent) break;
    nested.push(candidate.replace(new RegExp(`^[ \\t]{0,${baseIndent + 4}}`), ""));
    index += 1;
  }
  if (nested.length === 0) return start + 1;
  const merged = [...previous.blocks];
  const parsed = depth >= MAX_DEPTH
    ? [{ kind: "paragraph" as const, inline: parseInline(nested.join("\n")) }]
    : parseMarkdown(nested.join("\n"), depth + 1);
  previous.blocks = [...merged, ...parsed];
  return index;
}

interface TableParse {
  block: Extract<MarkdownBlock, { kind: "table" }>;
  next: number;
}

function parseTable(lines: readonly string[], start: number): TableParse | undefined {
  const header = lines[start] ?? "";
  const delimiter = lines[start + 1];
  if (!header.includes("|") || delimiter === undefined || !TABLE_DELIMITER.test(delimiter)) return undefined;
  const head = splitRow(header);
  const alignments = splitRow(delimiter).map<MarkdownAlignment>((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return undefined;
  });
  if (head.length === 0 || head.length !== alignments.length) return undefined;

  const rows: MarkdownInline[][][] = [];
  let index = start + 2;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || !line.includes("|") || startsBlock(line)) break;
    const cells = splitRow(line);
    rows.push(
      Array.from({ length: head.length }, (_unused, column) => parseInline(cells[column] ?? "")),
    );
    index += 1;
  }

  return {
    block: { kind: "table", alignments, head: head.map((cell) => parseInline(cell)), rows },
    next: index,
  };
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
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

export function parseInline(source: string, depth = 0): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let buffer = "";
  let index = 0;

  const flush = (): void => {
    if (buffer) nodes.push({ kind: "text", value: buffer });
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

interface LinkMatch {
  label: string;
  href: string;
  end: number;
}

function matchLink(source: string, start: number): LinkMatch | undefined {
  let depth = 0;
  let labelEnd = -1;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") depth += 1;
    if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        labelEnd = index;
        break;
      }
    }
    if (character === "\n") break;
  }
  if (labelEnd < 0 || source[labelEnd + 1] !== "(") return undefined;
  const close = source.indexOf(")", labelEnd + 2);
  if (close < 0) return undefined;
  const destination = source.slice(labelEnd + 2, close).trim().split(/\s+/)[0] ?? "";
  const href = destination.replace(/^<|>$/g, "");
  if (!LINK_SCHEME.test(href)) return undefined;
  return { label: source.slice(start + 1, labelEnd), href, end: close + 1 };
}

interface EmphasisMatch {
  node: MarkdownInline;
  end: number;
}

function matchEmphasis(source: string, start: number, depth: number): EmphasisMatch | undefined {
  const character = source[start] ?? "";
  const run = runLength(source, start, character);
  const width = character === "~" ? 2 : Math.min(run, 2);
  if (character === "~" && run < 2) return undefined;
  const marker = character.repeat(width);
  // `snake_case` must stay literal, so `_` only opens on a word boundary.
  if (character === "_" && isWordCharacter(source[start - 1])) return undefined;

  let index = start + width;
  while (index < source.length) {
    const candidate = source[index];
    if (candidate === "\\") {
      index += 2;
      continue;
    }
    if (candidate === character && source.startsWith(marker, index)) {
      const content = source.slice(start + width, index);
      if (content.trim() === "" || /^\s/.test(content) || /\s$/.test(content)) return undefined;
      if (character === "_" && isWordCharacter(source[index + width])) {
        index += width;
        continue;
      }
      const children = parseInline(content, depth + 1);
      const kind = character === "~" ? "strike" : width === 2 ? "strong" : "emphasis";
      return { node: { kind, children } as MarkdownInline, end: index + width };
    }
    index += 1;
  }
  return undefined;
}

function normalizeCodeSpan(value: string): string {
  const collapsed = value.replaceAll("\n", " ");
  return collapsed.length > 2 && collapsed.startsWith(" ") && collapsed.endsWith(" ") && collapsed.trim() !== ""
    ? collapsed.slice(1, -1)
    : collapsed;
}

function runLength(source: string, start: number, character: string): number {
  let length = 0;
  while (source[start + length] === character) length += 1;
  return length;
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

function indentWidth(value: string): number {
  let width = 0;
  for (const character of value) width += character === "\t" ? 4 : 1;
  return width;
}
