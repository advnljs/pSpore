import { constants as zlibConstants, gunzipSync, gzipSync } from "node:zlib";

import {
  encodeFrame,
  PROTOCOL_VERSION,
  type ServerFrame,
} from "./schema.js";

export const SERVER_FRAME_CHUNKS_CAPABILITY = "server-frame-chunks.v1";
export const DEFAULT_MAX_SERVER_MESSAGE_BYTES = 67_108_864;
const MAX_SERVER_FRAME_CHUNKS = 65_536;

type ChunkEncoding = "base64" | "gzip-base64";

interface ServerFrameChunk {
  v: 1;
  kind: "chunk";
  id: string;
  encoding: ChunkEncoding;
  index: number;
  count: number;
  payloadBytes: number;
  decodedBytes: number;
  data: string;
}

interface ChunkAssembly {
  id: string;
  encoding: ChunkEncoding;
  count: number;
  payloadBytes: number;
  decodedBytes: number;
  nextIndex: number;
  receivedBytes: number;
  parts: Buffer[];
}

export function encodeServerFrame(
  frame: ServerFrame,
  options: {
    maxFrameBytes: number;
    maxMessageBytes?: number;
    idFactory: () => string;
  },
): readonly string[] {
  const ordinary = encodeFrame(frame);
  if (Buffer.byteLength(ordinary, "utf8") <= options.maxFrameBytes) return [ordinary];
  if (options.maxFrameBytes < 512) throw new Error("Protocol frame limit is too small for chunk envelopes");

  const decoded = Buffer.from(JSON.stringify(frame), "utf8");
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_SERVER_MESSAGE_BYTES;
  if (decoded.byteLength > maxMessageBytes) {
    throw new Error(`Server protocol message exceeds ${maxMessageBytes} bytes`);
  }
  const compressed = gzipSync(decoded, { level: zlibConstants.Z_BEST_SPEED });
  const useCompression = compressed.byteLength < decoded.byteLength;
  const payload = useCompression ? compressed : decoded;
  const encoding: ChunkEncoding = useCompression ? "gzip-base64" : "base64";
  return chunkPayload(payload, decoded.byteLength, encoding, options.maxFrameBytes, options.idFactory());
}

export class ServerFrameDecoder {
  readonly #maxFrameBytes: number;
  readonly #maxMessageBytes: number;
  #assembly: ChunkAssembly | undefined;

  constructor(options: { maxFrameBytes: number; maxMessageBytes?: number }) {
    this.#maxFrameBytes = options.maxFrameBytes;
    this.#maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_SERVER_MESSAGE_BYTES;
  }

  reset(): void {
    this.#assembly = undefined;
  }

  decode(line: Uint8Array): ServerFrame | undefined {
    if (line.byteLength === 0) throw new Error("Server sent an empty protocol frame");
    if (line.byteLength > this.#maxFrameBytes) throw new Error("Server frame exceeded protocol limit");
    const value = parseJson(line);
    const record = asRecord(value, "server frame");
    if (record["v"] !== PROTOCOL_VERSION) throw new Error("Server protocol version is unsupported");
    if (record["kind"] !== "chunk") {
      if (this.#assembly) throw new Error("Server interrupted a chunked protocol message");
      return serverFrame(record);
    }
    return this.#decodeChunk(record);
  }

  #decodeChunk(record: Record<string, unknown>): ServerFrame | undefined {
    exactKeys(
      record,
      ["v", "kind", "id", "encoding", "index", "count", "payloadBytes", "decodedBytes", "data"],
      "server chunk",
    );
    const chunk: ServerFrameChunk = {
      v: PROTOCOL_VERSION,
      kind: "chunk",
      id: identifier(record["id"], "server chunk.id"),
      encoding: enumeration(record["encoding"], ["base64", "gzip-base64"], "server chunk.encoding"),
      index: boundedInteger(record["index"], "server chunk.index", 0, this.#maxMessageBytes),
      count: boundedInteger(record["count"], "server chunk.count", 1, MAX_SERVER_FRAME_CHUNKS),
      payloadBytes: boundedInteger(
        record["payloadBytes"],
        "server chunk.payloadBytes",
        1,
        this.#maxMessageBytes,
      ),
      decodedBytes: boundedInteger(
        record["decodedBytes"],
        "server chunk.decodedBytes",
        1,
        this.#maxMessageBytes,
      ),
      data: stringValue(record["data"], "server chunk.data"),
    };
    if (chunk.index >= chunk.count) throw new Error("Server chunk index is out of range");
    const part = Buffer.from(chunk.data, "base64");
    if (part.byteLength === 0 || part.toString("base64") !== chunk.data) {
      throw new Error("Server chunk data is not canonical base64");
    }

    let assembly = this.#assembly;
    if (!assembly) {
      if (chunk.index !== 0) throw new Error("Server chunk sequence did not start at index 0");
      assembly = {
        id: chunk.id,
        encoding: chunk.encoding,
        count: chunk.count,
        payloadBytes: chunk.payloadBytes,
        decodedBytes: chunk.decodedBytes,
        nextIndex: 0,
        receivedBytes: 0,
        parts: [],
      };
      this.#assembly = assembly;
    }
    if (
      chunk.id !== assembly.id
      || chunk.encoding !== assembly.encoding
      || chunk.count !== assembly.count
      || chunk.payloadBytes !== assembly.payloadBytes
      || chunk.decodedBytes !== assembly.decodedBytes
      || chunk.index !== assembly.nextIndex
    ) {
      throw new Error("Server chunk sequence is inconsistent");
    }
    if (assembly.receivedBytes + part.byteLength > assembly.payloadBytes) {
      throw new Error("Server chunk payload exceeds its declared length");
    }
    assembly.parts.push(part);
    assembly.receivedBytes += part.byteLength;
    assembly.nextIndex += 1;
    if (assembly.nextIndex < assembly.count) return undefined;

    this.#assembly = undefined;
    if (assembly.receivedBytes !== assembly.payloadBytes) {
      throw new Error("Server chunk payload length does not match its declaration");
    }
    const payload = Buffer.concat(assembly.parts, assembly.payloadBytes);
    let decoded: Buffer;
    try {
      decoded = assembly.encoding === "gzip-base64"
        ? gunzipSync(payload, { maxOutputLength: assembly.decodedBytes })
        : payload;
    } catch {
      throw new Error("Server chunk payload could not be decompressed safely");
    }
    if (decoded.byteLength !== assembly.decodedBytes) {
      throw new Error("Server chunk decoded length does not match its declaration");
    }
    const value = parseJson(decoded);
    const frame = asRecord(value, "chunked server frame");
    if (frame["v"] !== PROTOCOL_VERSION || frame["kind"] === "chunk") {
      throw new Error("Chunked server frame has an unsupported version or kind");
    }
    return serverFrame(frame);
  }
}

function chunkPayload(
  payload: Buffer,
  decodedBytes: number,
  encoding: ChunkEncoding,
  maxFrameBytes: number,
  id: string,
): readonly string[] {
  let partBytes = Math.max(1, Math.floor((maxFrameBytes - 384) * 0.75));
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const count = Math.ceil(payload.byteLength / partBytes);
    if (count > MAX_SERVER_FRAME_CHUNKS) {
      throw new Error(`Server protocol message requires more than ${MAX_SERVER_FRAME_CHUNKS} chunks`);
    }
    const frames: string[] = [];
    let fits = true;
    for (let index = 0; index < count; index += 1) {
      const data = payload.subarray(index * partBytes, Math.min(payload.byteLength, (index + 1) * partBytes));
      const frame: ServerFrameChunk = {
        v: PROTOCOL_VERSION,
        kind: "chunk",
        id,
        encoding,
        index,
        count,
        payloadBytes: payload.byteLength,
        decodedBytes,
        data: data.toString("base64"),
      };
      const encoded = `${JSON.stringify(frame)}\n`;
      if (Buffer.byteLength(encoded, "utf8") > maxFrameBytes) {
        fits = false;
        break;
      }
      frames.push(encoded);
    }
    if (fits) return frames;
    partBytes = Math.floor(partBytes * 0.8);
    if (partBytes < 1) break;
  }
  throw new Error("Protocol frame limit cannot fit a chunk envelope");
}

function parseJson(value: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  } catch {
    throw new Error("Server sent invalid protocol JSON");
  }
}

function serverFrame(record: Record<string, unknown>): ServerFrame {
  if (record["kind"] !== "hello_ack" && record["kind"] !== "event" && record["kind"] !== "response") {
    throw new Error("Server sent an unsupported protocol frame kind");
  }
  return record as unknown as ServerFrame;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !accepted.has(key));
  if (unknown.length > 0) throw new Error(`${path} contains unknown fields: ${unknown.join(", ")}`);
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${path} must be a non-empty identifier of at most 128 characters`);
  }
  return value;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${path} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function enumeration<const T extends string>(value: unknown, choices: readonly T[], path: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new Error(`${path} must be one of: ${choices.join(", ")}`);
  }
  return value as T;
}
