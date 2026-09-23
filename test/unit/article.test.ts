import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import {
  articleChangeCounts,
  articleLineChangeCounts,
  diffArticleBlocks,
  alignArticleDraft,
  diffArticleLines,
} from "../../src/articles/diff.js";
import { articleDraftFromUpdate } from "../../src/articles/draft.js";
import { markdownToDocx } from "../../src/articles/docx.js";
import { applyArticleEdits, previewArticleEdits } from "../../src/articles/edits.js";
import { markdownToPdfHtml } from "../../src/articles/html.js";
import { markdownToPlainText } from "../../src/articles/plain.js";
import { ArticlePreviewBus } from "../../src/articles/preview.js";
import { publishedArticleValue } from "../../src/articles/publish.js";
import { parseArticleReceipt } from "../../src/articles/receipt.js";
import { ArticleStore } from "../../src/articles/store.js";
import { createArticleTools } from "../../src/articles/tool.js";
import { ZipArchive } from "../../src/documents/zip.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("article diff and export text", () => {
  test("diffs paragraphs and keeps a fenced block intact", () => {
    const diff = diffArticleBlocks("甲\n\n乙\n\n```\nkeep\n```", "甲\n\n丙\n\n```\nkeep\n```");
    assert.deepEqual(diff.map((block) => block.kind), ["same", "remove", "add", "same"]);
    assert.equal(articleChangeCounts(diff).added, 1);
    assert.equal(articleChangeCounts(diff).removed, 1);
  });

  test("a draft keeps the part of the previous version it has not reached", () => {
    const previous = "# 报告\n\n第一段。\n\n第二段。\n\n第三段。\n";
    // The model has rewritten the first paragraph and is still typing.
    const aligned = alignArticleDraft(previous, "# 报告\n\n改写后的第一段。\n\n第二");
    assert.deepEqual(aligned.written, [
      { source: "# 报告", changed: false },
      { source: "改写后的第一段。", changed: true },
      { source: "第二", changed: true },
    ]);
    // The paragraph being typed is the start of the one it replaces, so it is
    // not also shown below; the untouched remainder is.
    assert.deepEqual(aligned.pending, ["第三段。"]);
  });

  test("a draft that has only just started still shows the whole previous version", () => {
    const previous = "# 报告\n\n第一段。\n\n第二段。\n";
    assert.deepEqual(alignArticleDraft(previous, "# 报").pending, ["第一段。", "第二段。"]);
    assert.deepEqual(alignArticleDraft(previous, "").pending, ["# 报告", "第一段。", "第二段。"]);
  });

  test("a finished draft leaves nothing pending", () => {
    const previous = "# 报告\n\n第一段。\n";
    const aligned = alignArticleDraft(previous, "# 报告\n\n第一段。\n\n新增一段。\n");
    assert.deepEqual(aligned.pending, []);
    assert.deepEqual(aligned.written.map((block) => block.changed), [false, false, true]);
  });

  test("a first version has no previous blocks to keep", () => {
    assert.deepEqual(alignArticleDraft("", "# 新文稿\n\n正文"), {
      written: [{ source: "# 新文稿", changed: true }, { source: "正文", changed: true }],
      pending: [],
    });
  });

  test("line diff marks the words that changed inside a rewritten line", () => {
    const diff = diffArticleLines("# 报告\n\n营收增长 12%。\n", "# 报告\n\n营收增长 23%。\n");
    assert.deepEqual(diff.map((line) => line.kind), ["same", "same", "remove", "add", "same"]);
    const removed = diff.find((line) => line.kind === "remove");
    const added = diff.find((line) => line.kind === "add");
    // The pair is close enough to mark inside rather than replacing whole lines.
    assert.deepEqual(removed?.segments, [
      { kind: "same", text: "营收增长 " },
      { kind: "remove", text: "12" },
      { kind: "same", text: "%。" },
    ]);
    assert.deepEqual(added?.segments, [
      { kind: "same", text: "营收增长 " },
      { kind: "add", text: "23" },
      { kind: "same", text: "%。" },
    ]);
    assert.deepEqual(articleLineChangeCounts(diff), { added: 1, removed: 1 });
  });

  test("line diff leaves unrelated lines as whole-line changes", () => {
    const diff = diffArticleLines("原来写的是噪声治理。\n", "The schedule slipped by two weeks.\n");
    const removed = diff.find((line) => line.kind === "remove");
    const added = diff.find((line) => line.kind === "add");
    // Marking a few incidental characters inside two different sentences would
    // read as noise, so the pair stays whole.
    assert.equal(removed?.segments, undefined);
    assert.equal(added?.segments, undefined);
  });

  test("line granularity reports the same lines without marking inside them", () => {
    const source = "# 报告\n\n营收增长 12%。\n";
    const next = "# 报告\n\n营收增长 23%。\n";
    const byLine = diffArticleLines(source, next, "line");
    assert.deepEqual(byLine.map((line) => line.kind), ["same", "same", "remove", "add", "same"]);
    assert.ok(byLine.every((line) => line.segments === undefined));
  });

  test("line diff numbers each line in the version it belongs to", () => {
    const diff = diffArticleLines("一\n二\n三\n", "一\n新增\n二\n三\n");
    assert.deepEqual(
      diff.map((line) => `${line.kind}:${line.number}:${line.text}`),
      ["same:1:一", "add:2:新增", "same:3:二", "same:4:三", "same:5:"],
    );
  });

  test("a rewrite of everything still produces a usable diff", () => {
    const diff = diffArticleLines("旧文。\n", "");
    assert.deepEqual(articleLineChangeCounts(diff), { added: 0, removed: 1 });
    assert.deepEqual(diff.map((line) => line.kind), ["remove", "same"]);
  });

  test("plain text drops markdown markers and keeps the words", () => {
    const plain = markdownToPlainText("# 标题\n\n这是**粗体**和`代码`\n\n- 第一项\n- 第二项\n\n[说明](https://example.com)\n\n| 列 | 值 |\n| --- | --- |\n| 甲 | 乙 |");
    assert.match(plain, /^标题\n\n这是粗体和代码/);
    assert.match(plain, /• 第一项/);
    assert.doesNotMatch(plain, /[#*`|[\]]/);
    assert.match(plain, /说明 \(https:\/\/example\.com\)/);
    assert.match(plain, /甲\t乙/);
  });

  test("plain text indents what sits under a list item", () => {
    const plain = markdownToPlainText("1. 第一层\n   - 第二层\n   - 第二层乙\n2. 收尾\n");
    assert.match(plain, /^1\. 第一层\n {2}• 第二层\n {2}• 第二层乙\n2\. 收尾$/);
  });

  test("pdf html escapes text and keeps heading structure", () => {
    const html = markdownToPdfHtml("# 标题\n\n<script>alert(1)</script> 与 **重点**", "标题");
    assert.match(html, /<h1>标题<\/h1>/);
    assert.match(html, /<strong>重点<\/strong>/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  });

  test("pdf html keeps a one-sentence list item on one line", () => {
    const html = markdownToPdfHtml("- [x] 已办\n- 普通项\n  - 下一层\n", "清单");
    // A block inside the <li> puts the checkbox on its own line and gives each
    // item a paragraph's margins.
    assert.match(html, /<li>☑ 已办<\/li>/);
    assert.match(html, /<li>普通项<ul><li>下一层<\/li><\/ul><\/li>/);
    assert.doesNotMatch(html, /<li>[^<]*<p>/);
  });

  test("docx is a zip whose document carries the heading and bold run", () => {
    const docx = markdownToDocx("# 周报\n\n本周完成了**授信**评审。", "周报");
    const archive = ZipArchive.open(docx);
    const xml = archive.readText("word/document.xml") ?? "";
    assert.match(xml, /周报/);
    assert.match(xml, /<w:pStyle w:val="Heading1"\/>/);
    assert.match(xml, /<w:b\/>/);
    assert.match(xml, /授信/);
    assert.equal(archive.has("word/styles.xml"), true);
  });

  test("docx declares every list level a nested list can reach", () => {
    const docx = markdownToDocx("1. 第一层\n   - 第二层\n     1. 第三层\n", "层级");
    const archive = ZipArchive.open(docx);
    const numbering = archive.readText("word/numbering.xml") ?? "";
    // Word gives an item no indent and no glyph when its ilvl is undeclared,
    // which flattens a nested list against the left margin.
    for (let level = 0; level < 9; level += 1) {
      assert.match(numbering, new RegExp(`<w:lvl w:ilvl="${level}">`, "g"), `level ${level} is not declared`);
    }
    const document = archive.readText("word/document.xml") ?? "";
    assert.match(document, /<w:ilvl w:val="1"\/>/);
    assert.match(document, /<w:ilvl w:val="2"\/>/);
  });

  test("docx entries carry a date a zip reader accepts", () => {
    const docx = markdownToDocx("# 标题\n\n正文。", "标题");
    // Local header: signature(4) version(2) flags(2) method(2) time(2) date(2).
    const time = docx.readUInt16LE(10);
    const date = docx.readUInt16LE(12);
    assert.equal(time, 0);
    // A zeroed date decodes as month 0 day 0, which is not a date.
    assert.equal((date >> 5) & 0x0f, 1);
    assert.equal(date & 0x1f, 1);
  });
});

describe("article store", () => {
  test("keeps versions, applies an edit, and refuses to escape the directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-article-"));
    roots.push(root);
    let tick = 0;
    const store = new ArticleStore(join(root, "articles"), () => new Date(Date.UTC(2026, 8, 22, tick++)));
    const created = await store.create({ sessionId: "main", title: "周报", content: "# 周报\n\n初稿" });
    assert.equal(created.version, 1);
    assert.match(parseArticleReceipt(`article ${created.id} version ${created.version}`)?.id ?? "", /^art_/);

    const revised = await store.update({
      sessionId: "main",
      id: created.id,
      edits: [{ find: "初稿", replace: "二稿" }],
    });
    assert.equal(revised.version, 2);
    assert.equal(revised.removed, 1);
    assert.equal(revised.added, 1);

    const same = await store.update({ sessionId: "main", id: created.id, content: "# 周报\n\n二稿" });
    assert.equal(same.unchanged, true);
    assert.equal(same.version, 2);

    const latest = await store.read({ sessionId: "main", id: created.id, offset: 0, limit: 20 });
    assert.match(latest?.text ?? "", /二稿/);
    const first = await store.read({ sessionId: "main", id: created.id, version: 1, offset: 0, limit: 20 });
    assert.match(first?.text ?? "", /初稿/);
    assert.equal(await store.read({ sessionId: "other", id: created.id, limit: 10 }), undefined);
    assert.equal(await store.read({ sessionId: "main", id: "../secret", limit: 10 }), undefined);

    const tools = createArticleTools("main", store);
    const article = tools[0];
    assert.ok(article);
    const result = await article.execute("call-1", { action: "read", id: created.id }, undefined, undefined, {} as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.equal(parseArticleReceipt(text)?.version, 2);
    assert.match(text, /二稿/);
    const published = publishedArticleValue("article", result);
    const publishedText = publishedArticleText(published);
    assert.match(publishedText, /^article /);
    assert.doesNotMatch(publishedText, /二稿/);
  });
});

describe("article preview", () => {
  test("throttles identical and too-frequent drafts", () => {
    const bus = new ArticlePreviewBus();
    const draft = { toolCallId: "call", sessionId: "main", action: "create" as const, content: "甲" };
    assert.equal(bus.note(draft, 0), true);
    assert.equal(bus.note(draft, 1_000), false);
    assert.equal(bus.note({ ...draft, content: "甲乙" }, 50), false);
    assert.equal(bus.note({ ...draft, content: "甲乙丙" }, 200), true);
    assert.equal(bus.get("call")?.content, "甲乙丙");
  });

  test("reads content out of a partial article tool call", () => {
    const draft = articleDraftFromUpdate("main", {
      type: "toolcall_delta",
      contentIndex: 0,
      partial: {
        content: [{
          type: "toolCall",
          id: "call-9",
          name: "article",
          arguments: { action: "create", title: "周报", content: "# 标题" },
        }],
      },
    }, undefined);
    assert.equal(draft?.toolCallId, "call-9");
    assert.equal(draft?.title, "周报");
    assert.equal(draft?.content, "# 标题");
    assert.equal(articleDraftFromUpdate("main", { type: "text_delta", contentIndex: 0 }, undefined), undefined);
  });

  test("a writing call counts before it has any body, so the panel can open at once", () => {
    const create = partialArticleCall({ action: "create", title: "周" });
    assert.equal(create?.action, "create");
    assert.equal(create?.content, undefined);
    const update = partialArticleCall({ action: "update", id: "art_0123456789ab" });
    assert.equal(update?.action, "update");
    assert.equal(update?.articleId, "art_0123456789ab");
    assert.equal(partialArticleCall({ action: "read", id: "art_0123456789ab" }), undefined);
    // Nothing says what the call does yet.
    assert.equal(partialArticleCall({ action: "upd" }), undefined);
  });

  test("an id still streaming names no article", () => {
    const draft = partialArticleCall({ action: "update", id: "art_01234" });
    assert.equal(draft?.action, "update");
    assert.equal(draft?.articleId, undefined);
  });

  test("an edit is followed once its quote is closed, and its replacement as it arrives", () => {
    // `find` is still being quoted: nothing can be placed yet.
    assert.deepEqual(partialArticleCall({ action: "update", id: "art_0123456789ab", edits: [{ find: "旧的一" }] })?.edits, []);
    const writing = partialArticleCall({
      action: "update",
      id: "art_0123456789ab",
      edits: [{ find: "甲", replace: "乙" }, { find: "旧的一句话。", replace: "新的" }],
    });
    assert.deepEqual(writing?.edits, [{ find: "甲", replace: "乙" }, { find: "旧的一句话。", replace: "新的" }]);
    assert.equal(writing?.editOpen, true);
    // Written the other way round, the quote might still be growing.
    const reversed = partialArticleCall({ action: "update", id: "art_0123456789ab", edits: [{ replace: "新的", find: "旧的" }] });
    assert.deepEqual(reversed?.edits, []);
    const ended = partialArticleCall(
      { action: "update", id: "art_0123456789ab", edits: [{ replace: "新的", find: "旧的" }] },
      "toolcall_end",
    );
    assert.deepEqual(ended?.edits, [{ find: "旧的", replace: "新的" }]);
    assert.equal(ended?.editOpen, false);
  });

  test("an edit that grew wakes the panel, one that did not stays quiet", () => {
    const bus = new ArticlePreviewBus();
    const base = { toolCallId: "call", sessionId: "main", action: "update" as const, articleId: "art_0123456789ab" };
    assert.equal(bus.note(base, 0), true);
    assert.equal(bus.note({ ...base, edits: [], editOpen: false }, 200), true);
    assert.equal(bus.note({ ...base, edits: [{ find: "甲", replace: "乙" }], editOpen: true }, 400), true);
    assert.equal(bus.note({ ...base, edits: [{ find: "甲", replace: "乙" }], editOpen: true }, 600), false);
    assert.equal(bus.note({ ...base, edits: [{ find: "甲", replace: "乙丙" }], editOpen: true }, 800), true);
  });
});

describe("article edits", () => {
  test("a commit replaces the first occurrence of each quote, in order, and refuses a missing one", () => {
    assert.equal(applyArticleEdits("甲乙甲", [{ find: "甲", replace: "丙" }, { find: "甲", replace: "丁" }]), "丙乙丁");
    assert.throws(() => applyArticleEdits("甲", [{ find: "乙", replace: "丙" }]), /could not find/);
  });

  test("a preview skips a quote it cannot place and counts the ones it applied", () => {
    const preview = previewArticleEdits("甲乙", [{ find: "无", replace: "丙" }, { find: "乙", replace: "丁" }], false);
    assert.equal(preview.text, "甲丁");
    assert.equal(preview.applied, 1);
  });

  test("a replacement that has not departed from the text it replaces leaves that text alone", () => {
    const base = "# 标题\n\n第一段。\n\n第二段。";
    // Extending a paragraph: the old words are typed again first.
    assert.equal(previewArticleEdits(base, [{ find: "第一段。", replace: "第一" }], true).text, base);
    assert.equal(
      previewArticleEdits(base, [{ find: "第一段。", replace: "第一段。新加的" }], true).text,
      "# 标题\n\n第一段。新加的\n\n第二段。",
    );
    // Once finished, the same text is the replacement, however short.
    assert.equal(previewArticleEdits(base, [{ find: "第一段。", replace: "第一" }], false).text, "# 标题\n\n第一\n\n第二段。");
  });

  test("a rewrite of several paragraphs keeps the ones it has not reached", () => {
    const base = "开头。\n\n甲段。\n\n乙段。\n\n结尾。";
    // One block written: it stands in for the first old one, the second is still there.
    const first = previewArticleEdits(base, [{ find: "甲段。\n\n乙段。", replace: "新甲段" }], true);
    assert.equal(first.text, "开头。\n\n新甲段\n\n乙段。\n\n结尾。");
    // The block being typed now is the second one's replacement.
    const second = previewArticleEdits(base, [{ find: "甲段。\n\n乙段。", replace: "新甲段。\n\n新" }], true);
    assert.equal(second.text, "开头。\n\n新甲段。\n\n新\n\n结尾。");
  });
});

function partialArticleCall(
  args: Record<string, unknown>,
  type: "toolcall_delta" | "toolcall_end" = "toolcall_delta",
): ReturnType<typeof articleDraftFromUpdate> {
  return articleDraftFromUpdate("main", {
    type,
    contentIndex: 0,
    partial: { content: [{ type: "toolCall", id: "call-1", name: "article", arguments: args }] },
  }, undefined);
}

function publishedArticleText(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const first = content[0];
  return typeof first === "object" && first !== null && "text" in first && typeof first.text === "string" ? first.text : "";
}
