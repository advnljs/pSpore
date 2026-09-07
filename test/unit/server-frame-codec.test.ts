import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { initialKernelState } from "../../src/kernel/state.js";
import {
  encodeServerFrame,
  ServerFrameDecoder,
} from "../../src/protocol/server-frame-codec.js";
import type { ServerHelloFrame } from "../../src/protocol/schema.js";

test("oversized server messages are gzip encoded, bounded, chunked, and losslessly reassembled", () => {
  const text = randomBytes(12_000).toString("base64");
  const frame: ServerHelloFrame = {
    v: 1,
    kind: "hello_ack",
    id: "hello-large",
    protocolVersion: 1,
    instanceId: "daemon-large",
    streamId: "kernel",
    latestSeq: 4,
    replayFromSeq: 1,
    snapshot: {
      ...initialKernelState(),
      sessions: {
        main: {
          sessionId: "main",
          upstreamSessionId: "upstream-main",
          cwd: "/workspace",
          status: "idle",
          thinking: "off",
          messages: [{ role: "assistant", text }],
          queue: { steering: [], followUp: [] },
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, costUsd: 0 },
        },
      },
    },
  };
  const encoded = encodeServerFrame(frame, {
    maxFrameBytes: 1_024,
    maxMessageBytes: 64_000,
    idFactory: () => "chunk-large",
  });
  assert.ok(encoded.length > 1);
  assert.ok(encoded.every((line) => Buffer.byteLength(line, "utf8") <= 1_024));

  const decoder = new ServerFrameDecoder({ maxFrameBytes: 1_024, maxMessageBytes: 64_000 });
  let decoded;
  for (const line of encoded) decoded = decoder.decode(Buffer.from(line.slice(0, -1), "utf8")) ?? decoded;
  assert.deepEqual(decoded, frame);
});

test("ordinary server frames retain the newline-delimited v1 wire format", () => {
  const frame: ServerHelloFrame = {
    v: 1,
    kind: "hello_ack",
    id: "hello-small",
    protocolVersion: 1,
    instanceId: "daemon-small",
    streamId: "kernel",
    latestSeq: 0,
    replayFromSeq: 1,
    snapshot: initialKernelState(),
  };
  const [encoded] = encodeServerFrame(frame, {
    maxFrameBytes: 64_000,
    idFactory: () => "unused",
  });
  assert.equal(encoded, `${JSON.stringify(frame)}\n`);
  const decoder = new ServerFrameDecoder({ maxFrameBytes: 64_000 });
  assert.deepEqual(decoder.decode(Buffer.from(encoded.slice(0, -1), "utf8")), frame);
});

test("server frame codec rejects oversized logical messages and inconsistent chunk order", () => {
  const oversized: ServerHelloFrame = {
    v: 1,
    kind: "hello_ack",
    id: "hello-oversized",
    protocolVersion: 1,
    instanceId: "daemon-oversized",
    streamId: "kernel",
    latestSeq: 0,
    replayFromSeq: 1,
    snapshot: {
      ...initialKernelState(),
      sessions: {
        main: {
          sessionId: "main",
          upstreamSessionId: "upstream-oversized",
          cwd: "/workspace",
          status: "idle",
          thinking: "off",
          messages: [{ role: "assistant", text: "x".repeat(4_000) }],
          queue: { steering: [], followUp: [] },
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, costUsd: 0 },
        },
      },
    },
  };
  assert.throws(
    () => encodeServerFrame(oversized, {
      maxFrameBytes: 512,
      maxMessageBytes: 2_000,
      idFactory: () => "chunk-oversized",
    }),
    /exceeds 2000 bytes/,
  );

  const encoded = encodeServerFrame(oversized, {
    maxFrameBytes: 512,
    maxMessageBytes: 8_000,
    idFactory: () => "chunk-order",
  });
  assert.ok(encoded.length > 1);
  const decoder = new ServerFrameDecoder({ maxFrameBytes: 512, maxMessageBytes: 8_000 });
  assert.throws(
    () => decoder.decode(Buffer.from(encoded[1]!.slice(0, -1), "utf8")),
    /did not start at index 0/,
  );
});
