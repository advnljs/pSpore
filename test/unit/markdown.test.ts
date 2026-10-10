import assert from "node:assert/strict";
import test from "node:test";

import { parseInline, parseMarkdown, type MarkdownBlock, type MarkdownInline } from "../../src/ui/shared/markdown.js";

/** Flattens a block tree back to text so assertions stay readable. */
function plain(nodes: readonly MarkdownInline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
        case "code":
          return node.value;
        case "break":
          return "\n";
        default:
          return plain(node.children);
      }
    })
    .join("");
}

test("headings, paragraphs and thematic breaks parse as separate blocks", () => {
  const blocks = parseMarkdown("# Title\n\nfirst line\nsecond line\n\n---\n\n### Deep\n");
  assert.deepEqual(blocks.map((block) => block.kind), ["heading", "paragraph", "rule", "heading"]);
  const [heading, paragraph, , deep] = blocks as [
    Extract<MarkdownBlock, { kind: "heading" }>,
    Extract<MarkdownBlock, { kind: "paragraph" }>,
    MarkdownBlock,
    Extract<MarkdownBlock, { kind: "heading" }>,
  ];
  assert.equal(heading.level, 1);
  assert.equal(plain(heading.inline), "Title");
  assert.equal(plain(paragraph.inline), "first line\nsecond line");
  assert.equal(deep.level, 3);
});

test("fenced code keeps its language, content and closed state", () => {
  const blocks = parseMarkdown("before\n\n```ts\nconst a = 1;\n\n  indented();\n```\n\nafter");
  const code = blocks[1] as Extract<MarkdownBlock, { kind: "code" }>;
  assert.equal(code.kind, "code");
  assert.equal(code.language, "ts");
  assert.equal(code.value, "const a = 1;\n\n  indented();");
  assert.equal(code.closed, true);
  assert.equal(blocks.at(-1)?.kind, "paragraph");
});

test("an unterminated fence still renders as code so streaming stays stable", () => {
  const blocks = parseMarkdown("intro\n\n```bash\nnpm run build");
  const code = blocks[1] as Extract<MarkdownBlock, { kind: "code" }>;
  assert.equal(code.kind, "code");
  assert.equal(code.closed, false);
  assert.equal(code.value, "npm run build");
});

test("markdown markers inside a fence are not parsed as blocks", () => {
  const blocks = parseMarkdown("```\n# not a heading\n- not a list\n```");
  assert.equal(blocks.length, 1);
  assert.equal((blocks[0] as Extract<MarkdownBlock, { kind: "code" }>).value, "# not a heading\n- not a list");
});

test("bullet, ordered and task lists parse with nesting", () => {
  const blocks = parseMarkdown("- one\n- two\n  - nested\n- [x] done\n- [ ] pending\n");
  const list = blocks[0] as Extract<MarkdownBlock, { kind: "list" }>;
  assert.equal(list.kind, "list");
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 4);
  assert.equal(plain((list.items[0]?.blocks[0] as Extract<MarkdownBlock, { kind: "paragraph" }>).inline), "one");
  const nested = list.items[1]?.blocks[1] as Extract<MarkdownBlock, { kind: "list" }>;
  assert.equal(nested.kind, "list");
  assert.equal(plain((nested.items[0]?.blocks[0] as Extract<MarkdownBlock, { kind: "paragraph" }>).inline), "nested");
  assert.equal(list.items[2]?.checked, true);
  assert.equal(list.items[3]?.checked, false);

  const ordered = parseMarkdown("3. third\n4. fourth")[0] as Extract<MarkdownBlock, { kind: "list" }>;
  assert.equal(ordered.ordered, true);
  assert.equal(ordered.start, 3);
  assert.equal(ordered.items.length, 2);
});

test("a bullet list after an ordered list starts its own block", () => {
  const blocks = parseMarkdown("1. first\n2. second\n\n- [x] done\n- [ ] pending\n");
  assert.deepEqual(blocks.map((block) => block.kind), ["list", "list"]);
  const ordered = blocks[0] as Extract<MarkdownBlock, { kind: "list" }>;
  const tasks = blocks[1] as Extract<MarkdownBlock, { kind: "list" }>;
  assert.equal(ordered.ordered, true);
  assert.equal(ordered.items.length, 2);
  assert.equal(tasks.ordered, false);
  assert.deepEqual(tasks.items.map((item) => item.checked), [true, false]);
});

test("blockquotes parse their own nested blocks", () => {
  const blocks = parseMarkdown("> quoted line\n> - item\n\nplain");
  const quote = blocks[0] as Extract<MarkdownBlock, { kind: "quote" }>;
  assert.equal(quote.kind, "quote");
  assert.deepEqual(quote.blocks.map((block) => block.kind), ["paragraph", "list"]);
  assert.equal(blocks[1]?.kind, "paragraph");
});

test("pipe tables parse header, alignment and rows", () => {
  const blocks = parseMarkdown("| name | count |\n| :--- | ---: |\n| a | 1 |\n| b | 2 |\n");
  const table = blocks[0] as Extract<MarkdownBlock, { kind: "table" }>;
  assert.equal(table.kind, "table");
  assert.deepEqual(table.alignments, ["left", "right"]);
  assert.deepEqual(table.head.map((cell) => plain(cell)), ["name", "count"]);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[1]?.map((cell) => plain(cell)), ["b", "2"]);
});

test("a pipe line without a delimiter row stays a paragraph", () => {
  const blocks = parseMarkdown("a | b\nc | d");
  assert.deepEqual(blocks.map((block) => block.kind), ["paragraph"]);
});

test("inline emphasis, code, strikethrough and escapes", () => {
  const nodes = parseInline("**bold** *italic* ~~gone~~ `a * b` \\*literal\\*");
  assert.deepEqual(nodes.map((node) => node.kind), [
    "strong",
    "text",
    "emphasis",
    "text",
    "strike",
    "text",
    "code",
    "text",
  ]);
  assert.equal(plain(nodes), "bold italic gone a * b *literal*");
});

test("underscores inside identifiers stay literal", () => {
  const nodes = parseInline("call snake_case_name now");
  assert.deepEqual(nodes, [{ kind: "text", value: "call snake_case_name now" }]);
});

test("links keep safe schemes and drop everything else", () => {
  const link = parseInline("see [docs](https://example.com/a)")[1] as Extract<MarkdownInline, { kind: "link" }>;
  assert.equal(link.kind, "link");
  assert.equal(link.href, "https://example.com/a");
  assert.equal(plain(link.children), "docs");
  const local = parseInline("[报告](/tmp/report.txt) [目录](file:///tmp/results/)");
  assert.equal((local[0] as Extract<MarkdownInline, { kind: "link" }>).href, "/tmp/report.txt");
  assert.equal((local[2] as Extract<MarkdownInline, { kind: "link" }>).href, "file:///tmp/results/");
  assert.deepEqual(parseInline("[x](javascript:alert(1))"), [{ kind: "text", value: "[x](javascript:alert(1))" }]);
});

test("unbalanced markers are left as literal text", () => {
  assert.equal(plain(parseInline("2 * 3 * 4")), "2 * 3 * 4");
  assert.equal(plain(parseInline("`unclosed code")), "`unclosed code");
  assert.equal(plain(parseInline("**unclosed bold")), "**unclosed bold");
});

test("plain prose round-trips unchanged", () => {
  const blocks = parseMarkdown("just a sentence with (parens) and 100% certainty");
  assert.equal(blocks.length, 1);
  assert.equal(plain((blocks[0] as Extract<MarkdownBlock, { kind: "paragraph" }>).inline), "just a sentence with (parens) and 100% certainty");
});

test("deeply nested markdown terminates instead of recursing without bound", () => {
  const nested = `${"> ".repeat(40)}deep`;
  assert.doesNotThrow(() => parseMarkdown(nested));
  assert.doesNotThrow(() => parseInline("*".repeat(200)));
  assert.doesNotThrow(() => parseMarkdown(`${"- ".repeat(1)}${"  ".repeat(0)}item\n${"    ".repeat(20)}- deep`));
});
