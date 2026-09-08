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
import { assertSafeProtocolValue, validateKernelState } from "../../src/desktop/validation.js";
import { initialKernelState, type KernelState } from "../../src/kernel/state.js";

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

  test("strips the one character a client refuses, so a binary read cannot lock it out", () => {
    // Reading a .docx — a ZIP — decodes to text carrying NUL bytes. Those ride
    // into the authoritative snapshot, which a client re-validates on every
    // reconnect, so one of them used to lock the desktop out for good.
    const toolOutput = `path: /home/user/notes.docx\nsha256: abc\n\nPK${NUL}${NUL}binary`;
    const snapshot = kernelStateWithToolOutput(toolOutput);
    assert.throws(
      () => validateKernelState(snapshot),
      /sessions\.session-1\.messages\[2]\.text must be a bounded string/,
    );

    const bounded = boundPublishedValue(snapshot);
    assert.deepEqual(validateKernelState(bounded), bounded);
    const published = bounded.sessions["session-1"]?.messages[2]?.text ?? "";
    assert.equal(published.includes(NUL), false);
    // Replaced rather than dropped, so the reader can see something was there,
    // and the length is unchanged so nothing is pushed back over a ceiling.
    assert.match(published, /PK\uFFFD\uFFFDbinary$/);
    assert.equal(published.length, toolOutput.length);
  });

  test("still reports what it cut when a long string also carried a refused character", () => {
    const original = `${NUL}${"y".repeat(MAX_PUBLISHED_STRING_CHARS + 500)}`;
    const bounded = boundPublishedText(original);
    assert.equal(bounded.includes(NUL), false);
    assert.equal(bounded.length, MAX_PUBLISHED_STRING_CHARS);
    assert.deepEqual(publishedTextTruncation(bounded), {
      kept: MAX_PUBLISHED_STRING_CHARS,
      total: original.length,
    });
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

const NUL = "\u0000";

/** A snapshot shaped like the one the desktop rejected, with the tool output last. */
function kernelStateWithToolOutput(toolOutput: string): KernelState {
  return {
    ...initialKernelState(),
    sessions: {
      "session-1": {
        sessionId: "session-1",
        upstreamSessionId: "upstream-1",
        cwd: "/home/user",
        status: "running",
        model: { provider: "local", model: "test" },
        thinking: "off",
        messages: [
          { role: "user", text: "summarize this" },
          { role: "assistant", text: "reading the file" },
          { role: "tool", text: toolOutput },
        ],
        messageCount: 3,
        messageOffset: 0,
        queue: { steering: [], followUp: [] },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, costUsd: 0 },
      },
    },
  };
}

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
