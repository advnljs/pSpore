import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FULL_MESSAGE_SLICE_CHARS, readFullMessage } from "../../src/ui/shared/full-message.js";

describe("restoring a message the publishing ceiling cut", () => {
  test("pages through slices no larger than the daemon publishes", async () => {
    const original = "z".repeat(FULL_MESSAGE_SLICE_CHARS * 2 + 17);
    const requests: Array<{ offset: number; limit: number }> = [];
    const restored = await readFullMessage(async (offset, limit) => {
      requests.push({ offset, limit });
      return { offset, length: original.length, text: original.slice(offset, offset + limit) };
    });

    assert.equal(restored, original);
    assert.deepEqual(requests.map((request) => request.offset), [
      0,
      FULL_MESSAGE_SLICE_CHARS,
      FULL_MESSAGE_SLICE_CHARS * 2,
    ]);
    assert.ok(requests.every((request) => request.limit === FULL_MESSAGE_SLICE_CHARS));
  });

  test("returns in one request when the message fits a single slice", async () => {
    let calls = 0;
    const restored = await readFullMessage(async (offset) => {
      calls += 1;
      return { offset, length: 5, text: "short" };
    });
    assert.equal(restored, "short");
    assert.equal(calls, 1);
  });

  test("refuses slices that do not line up rather than splicing two messages", async () => {
    // A message renumbered mid-read answers from the wrong offset.
    assert.equal(await readFullMessage(async () => ({ offset: 4, length: 9, text: "later" })), undefined);
    // A peer that stops making progress must not be paged forever.
    assert.equal(
      await readFullMessage(async (offset) => ({ offset, length: 9, text: "" })),
      undefined,
    );
    assert.equal(await readFullMessage(async () => null), undefined);
    assert.equal(await readFullMessage(async () => ({ offset: 0, length: 3 })), undefined);
  });
});
