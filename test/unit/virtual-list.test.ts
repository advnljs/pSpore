import assert from "node:assert/strict";
import test from "node:test";

import { isScrollNearEnd, VirtualHeightIndex } from "../../src/ui/shared/virtual-list.js";

test("scroll end detection pauses history following until the viewport returns to the tail", () => {
  assert.equal(isScrollNearEnd(2_000, 1_000, 800), false);
  assert.equal(isScrollNearEnd(2_000, 1_176, 800), true);
  assert.equal(isScrollNearEnd(2_000, 1_200, 800), true);
  assert.equal(isScrollNearEnd(600, 0, 800), true);
  assert.equal(isScrollNearEnd(Number.NaN, 0, 800), false);
});

test("virtual height index bounds a 10000-message transcript to the viewport", () => {
  const index = new VirtualHeightIndex(100);
  index.sync(Array.from({ length: 10_000 }, (_, item) => `message-${item}`));
  const range = index.range(500_000, 1_000, 300);
  assert.ok(range.start >= 4_997);
  assert.ok(range.end <= 5_014);
  assert.ok(range.end - range.start < 20);
  assert.equal(range.totalSize, 1_000_000);
  assert.equal(range.paddingStart + range.paddingEnd + ((range.end - range.start) * 100), range.totalSize);
});

test("virtual height index applies variable measurements without scanning the list", () => {
  const index = new VirtualHeightIndex(100);
  index.sync(["a", "b", "c", "d"]);
  assert.equal(index.update("b", 250), true);
  assert.equal(index.update("b", 250), false);
  assert.equal(index.totalSize(), 550);
  assert.deepEqual(index.range(340, 50, 0), {
    start: 1,
    end: 3,
    paddingStart: 100,
    paddingEnd: 100,
    totalSize: 550,
  });
});

test("virtual height index keeps the item a reader is selecting inside the window", () => {
  const index = new VirtualHeightIndex(100);
  index.sync(Array.from({ length: 200 }, (_, item) => `message-${item}`));
  const without = index.range(10_000, 500, 0);
  assert.equal(without.start, 100);

  // Holding a selection a little above the viewport keeps that message rendered;
  // dropping its element is what collapses the selection mid-drag.
  const kept = index.range(10_000, 500, 0, 96);
  assert.equal(kept.start, 96);
  assert.equal(kept.end, without.end);
  assert.equal(kept.paddingStart, 9_600);
  assert.equal(kept.paddingStart + kept.paddingEnd + ((kept.end - kept.start) * 100), kept.totalSize);

  // Far-away scrollback is let go rather than rendering the whole gap.
  assert.equal(index.range(10_000, 500, 0, 2).start, without.start);
  assert.equal(index.range(10_000, 500, 0, 199).end, without.end);
  // Out-of-bounds and non-integer keeps are ignored.
  assert.equal(index.range(10_000, 500, 0, -1).start, without.start);
  assert.equal(index.range(10_000, 500, 0, 1.5).start, without.start);
});
