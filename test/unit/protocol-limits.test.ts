import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  boundPublishedText,
  boundPublishedValue,
  MAX_PROTOCOL_COLLECTION_ENTRIES,
  MAX_PROTOCOL_DEPTH,
  MAX_PROTOCOL_STRING_CHARS,
  MAX_PUBLISHED_COLLECTION_ENTRIES,
  MAX_PUBLISHED_STRING_CHARS,
  MAX_PUBLISHED_VALUE_CHARS,
  publishedTextTruncation,
} from "../../src/protocol/limits.js";
import { assertSafeProtocolValue } from "../../src/desktop/validation.js";

describe("published protocol bounds", () => {
  test("keeps every published value inside what a client will accept", () => {
    const value = {
      result: "x".repeat(MAX_PROTOCOL_STRING_CHARS * 2),
      messages: Array.from({ length: MAX_PROTOCOL_COLLECTION_ENTRIES * 2 }, (_, index) => ({
        role: "assistant",
        text: `m${index}`,
      })),
      nested: deepValue(MAX_PROTOCOL_DEPTH + 8),
    };

    assert.throws(() => assertSafeProtocolValue(value), /exceeds 262144 characters/);

    const bounded = boundPublishedValue(value);
    assertSafeProtocolValue(bounded);
    assert.equal(bounded.result.length, MAX_PUBLISHED_STRING_CHARS);
    assert.match(bounded.result, /truncated to 65536 of 524288 characters]$/);
    assert.equal(bounded.messages.length, MAX_PUBLISHED_COLLECTION_ENTRIES);
    // Transcripts are append-only, so the newest entries are the ones to keep.
    assert.equal(bounded.messages.at(-1)?.text, `m${MAX_PROTOCOL_COLLECTION_ENTRIES * 2 - 1}`);
  });

  test("shares structure when nothing exceeds a bound", () => {
    const value = { session: { messages: [{ role: "user", text: "short" }] } };
    assert.equal(boundPublishedValue(value), value);
    assert.equal(boundPublishedText("short"), "short");
  });

  test("reports what a cut string lost, so a client can offer to fetch the rest", () => {
    const original = "z".repeat(MAX_PUBLISHED_STRING_CHARS + 1_234);
    const bounded = boundPublishedText(original);
    assert.deepEqual(publishedTextTruncation(bounded), {
      kept: MAX_PUBLISHED_STRING_CHARS,
      total: original.length,
    });
    // Text that merely mentions truncation is not a marker this parser accepts.
    assert.equal(publishedTextTruncation("nothing was truncated here"), undefined);
    assert.equal(publishedTextTruncation(boundPublishedText("short")), undefined);
    assert.equal(publishedTextTruncation("…[truncated to 10 of 4 characters]"), undefined);
  });

  test("replaces values nested past the published depth instead of dropping the frame", () => {
    const bounded = boundPublishedValue({ deep: deepValue(64) }) as Record<string, unknown>;
    assertSafeProtocolValue(bounded);
    assert.match(JSON.stringify(bounded), /truncated: value nested too deeply/);
  });
});

test("spends a whole-value budget on the newest transcript entries", () => {
  const text = "y".repeat(MAX_PUBLISHED_STRING_CHARS);
  const messages = Array.from({ length: 400 }, (_, index) => ({ role: "assistant", text, index }));
  const bounded = boundPublishedValue({ session: { messages } }) as {
    session: { messages: Array<{ index: number }> };
  };

  const kept = bounded.session.messages;
  assert.ok(kept.length > 0 && kept.length < messages.length, "an oversized transcript is trimmed, not dropped");
  assert.ok(
    JSON.stringify(bounded).length <= MAX_PUBLISHED_VALUE_CHARS + MAX_PUBLISHED_STRING_CHARS,
    "the published value stays inside the budget a frame can carry",
  );
  // Order survives, and it is the tail that is kept.
  assert.equal(kept.at(-1)?.index, 399);
  assert.deepEqual(kept.map((message) => message.index), kept.map((message) => message.index).sort((a, b) => a - b));
});

function deepValue(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) value = { value };
  return value;
}
