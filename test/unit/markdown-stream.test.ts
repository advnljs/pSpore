import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { commonBlockPrefix, markdownBlockKeys } from "../../src/ui/shared/markdown-stream.js";

describe("streaming markdown block reuse", () => {
  test("a token that extends the last block leaves the ones before it untouched", () => {
    const written = "# 结论\n\n第一段已经写完。\n\n第二段正在写";
    const next = `${written}，还差几个字。`;
    const before = markdownBlockKeys(written);
    const after = markdownBlockKeys(next);
    assert.equal(before.length, 3);
    assert.equal(after.length, 3);
    // Two of three blocks can stay on screen — which is what keeps a selection
    // inside them alive while the reply is still arriving.
    assert.equal(commonBlockPrefix(before, after), 2);
  });

  test("starting a new block keeps everything already written", () => {
    const written = "开头。\n\n中段。";
    const after = markdownBlockKeys(`${written}\n\n新的一段`);
    assert.equal(commonBlockPrefix(markdownBlockKeys(written), after), 2);
    assert.equal(after.length, 3);
  });

  test("a change that rewrites earlier structure gives up only what it has to", () => {
    // The fence turns everything after it into one code block, so the paragraph
    // that used to follow is no longer the same block.
    const before = markdownBlockKeys("标题段。\n\n```ts\ncode\n```\n\n尾段。");
    const after = markdownBlockKeys("标题段。\n\n```ts\ncode\n\n尾段。");
    assert.equal(commonBlockPrefix(before, after), 1);
  });

  test("whitespace that does not survive parsing does not invalidate a block", () => {
    const before = markdownBlockKeys("一段文字。   \n\n第二段");
    const after = markdownBlockKeys("一段文字。\n\n第二段");
    assert.equal(commonBlockPrefix(before, after), 2);
  });

  test("an empty source shares nothing with a written one", () => {
    assert.equal(commonBlockPrefix(markdownBlockKeys(""), markdownBlockKeys("正文")), 0);
  });
});
