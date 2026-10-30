import assert from "node:assert/strict";
import test from "node:test";

import { findTextHits } from "../../src/desktop/renderer/session-find.js";

test("session search finds case-insensitive hits and walks them in order", () => {
  const result = findTextHits(
    ["先看 Report，再看 report。", "没有", "REPORT 在第三段"],
    "report",
  );
  assert.equal(result.capped, false);
  assert.deepEqual(result.hits, [
    { index: 0, occurrence: 0 },
    { index: 0, occurrence: 1 },
    { index: 2, occurrence: 0 },
  ]);
});

test("session search ignores blank queries and does not overlap matches", () => {
  assert.deepEqual(findTextHits(["aaa"], "  "), { hits: [], capped: false });
  assert.deepEqual(findTextHits(["aaaa"], "aa").hits, [
    { index: 0, occurrence: 0 },
    { index: 0, occurrence: 1 },
  ]);
});

test("session search stops at the hit cap", () => {
  const result = findTextHits(["x".repeat(2_000)], "x");
  assert.equal(result.capped, true);
  assert.equal(result.hits.length, 500);
  assert.equal(result.hits[499]?.occurrence, 499);
});
