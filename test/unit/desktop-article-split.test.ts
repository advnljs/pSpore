import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_ARTICLE_WIDTH,
  MIN_CONVERSATION_WIDTH,
  articleShareForWidth,
  articleWidthBounds,
  articleWidthForShare,
  clampArticleWidth,
} from "../../src/desktop/renderer/article-split.js";

// 1920 wide: 12px page padding each side, a 264px session rail, two 10px gaps.
const WIDE = 1_920 - 24 - 264 - 20;
// The shell's minimum window, 1180 wide, with the 238px rail open.
const SMALLEST = 1_180 - 24 - 238 - 20;

test("the document never takes the space the conversation needs", () => {
  assert.equal(clampArticleWidth(10_000, WIDE), WIDE - MIN_CONVERSATION_WIDTH);
  assert.equal(clampArticleWidth(0, WIDE), MIN_ARTICLE_WIDTH);
  assert.equal(clampArticleWidth(800, WIDE), 800);
});

test("the bound comes from the space beside the rail, not from the viewport", () => {
  // The old bound was innerWidth - 560 = 1360, which left the conversation 252px.
  const widest = articleWidthBounds(WIDE).max;
  assert.ok(WIDE - widest >= MIN_CONVERSATION_WIDTH);
  assert.ok(widest < 1_920 - 560);
});

test("the smallest window still has room for both halves", () => {
  const { min, max } = articleWidthBounds(SMALLEST);
  assert.equal(min, MIN_ARTICLE_WIDTH);
  assert.ok(max >= min);
  const even = articleWidthForShare(undefined, SMALLEST);
  assert.ok(even >= MIN_ARTICLE_WIDTH);
  assert.ok(SMALLEST - even >= MIN_CONVERSATION_WIDTH);
});

test("when both minimums do not fit, both halves give way in proportion", () => {
  const { min, max } = articleWidthBounds(600);
  assert.equal(min, max);
  assert.ok(min > 0 && min < 600 - min);
  assert.deepEqual(articleWidthBounds(-5), { min: 0, max: 0 });
});

test("a remembered split scales with the space instead of keeping its pixels", () => {
  const share = articleShareForWidth(900, WIDE);
  assert.ok(share !== undefined);
  assert.equal(articleWidthForShare(share, WIDE), 900);
  const smaller = articleWidthForShare(share, 1_200);
  assert.ok(Math.abs(smaller - 1_200 * share) <= 1 || smaller === 1_200 - MIN_CONVERSATION_WIDTH);
  // Growing the window back returns the same split.
  assert.equal(articleWidthForShare(share, WIDE), 900);
});

test("no choice yet, or a nonsense one, splits the space evenly", () => {
  assert.equal(articleWidthForShare(undefined, WIDE), Math.round(WIDE / 2));
  assert.equal(articleWidthForShare(Number.NaN, WIDE), Math.round(WIDE / 2));
  assert.equal(articleWidthForShare(1.4, WIDE), Math.round(WIDE / 2));
  assert.equal(articleShareForWidth(100, 0), undefined);
});
