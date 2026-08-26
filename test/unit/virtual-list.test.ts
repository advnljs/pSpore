import assert from "node:assert/strict";
import test from "node:test";

import { VirtualHeightIndex } from "../../src/ui/shared/virtual-list.js";

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
