import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { decodeClientFrame, ProtocolError } from "../../src/protocol/schema.js";

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("protocol schema", () => {
  test("accepts a strict versioned hello and command", () => {
    assert.equal(
      decodeClientFrame(
        bytes({
          v: 1,
          kind: "hello",
          id: "hello-1",
          clientId: "tui-1",
          supportedVersions: [1],
          capabilities: ["tui"],
          cursors: { kernel: 2 },
        }),
      ).kind,
      "hello",
    );
    const command = decodeClientFrame(
      bytes({
        v: 1,
        kind: "command",
        id: "command-1",
        clientId: "tui-1",
        sessionId: "main",
        expectedRevision: 2,
        type: "session.prompt",
        payload: { text: "hello" },
      }),
    );
    assert.equal(command.kind, "command");
  });

  test("rejects unknown fields, unsupported versions, deep JSON and oversized frames", () => {
    assert.throws(
      () =>
        decodeClientFrame(
          bytes({
            v: 1,
            kind: "hello",
            id: "h",
            clientId: "c",
            supportedVersions: [1],
            capabilities: [],
            cursors: {},
            unexpected: true,
          }),
        ),
      (error: unknown) => error instanceof ProtocolError && error.code === "unknown_field",
    );
    assert.throws(
      () => decodeClientFrame(bytes({ v: 2, kind: "command" })),
      (error: unknown) => error instanceof ProtocolError && error.code === "unsupported_version",
    );
    let nested: unknown = "leaf";
    for (let index = 0; index < 40; index++) nested = { nested };
    assert.throws(
      () =>
        decodeClientFrame(
          bytes({ v: 1, kind: "command", id: "c", clientId: "x", type: "status.get", payload: nested }),
        ),
      (error: unknown) => error instanceof ProtocolError && error.code === "nesting_too_deep",
    );
    assert.throws(
      () => decodeClientFrame(Buffer.alloc(20), 10),
      (error: unknown) => error instanceof ProtocolError && error.code === "frame_too_large",
    );
  });
});
