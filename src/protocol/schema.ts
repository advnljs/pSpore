import type { KernelState, PublicKernelEvent } from "../kernel/state.js";

export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_MAX_FRAME_BYTES = 1_048_576;
export const DEFAULT_MAX_NESTING_DEPTH = 32;
export const DEFAULT_MAX_STRING_LENGTH = 262_144;

export interface ClientHelloFrame {
  v: 1;
  kind: "hello";
  id: string;
  clientId: string;
  supportedVersions: number[];
  capabilities: string[];
  cursors: Record<string, number>;
}

export interface ServerHelloFrame {
  v: 1;
  kind: "hello_ack";
  id: string;
  protocolVersion: 1;
  instanceId: string;
  streamId: string;
  latestSeq: number;
  replayFromSeq: number;
  snapshot: KernelState;
}

export interface CommandEnvelope<T = unknown> {
  v: 1;
  kind: "command";
  id: string;
  clientId: string;
  sessionId?: string;
  expectedRevision?: number;
  type: string;
  payload: T;
}

export interface ResponseEnvelope<T = unknown> {
  v: 1;
  kind: "response";
  id: string;
  commandId: string;
  ok: boolean;
  payload?: T;
  error?: { code: string; message: string; currentRevision?: number };
}

export interface EventEnvelope<T = unknown> {
  v: 1;
  kind: "event";
  id: string;
  streamId: string;
  seq: number;
  ts: string;
  correlationId?: string;
  causationId?: string;
  durable: boolean;
  type: string;
  payload: T;
}

export type ClientFrame = ClientHelloFrame | CommandEnvelope;
export type ServerFrame = ServerHelloFrame | ResponseEnvelope | EventEnvelope;

export function decodeClientFrame(line: Uint8Array, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): ClientFrame {
  if (line.byteLength === 0) throw new ProtocolError("empty_frame", "Protocol frame cannot be empty");
  if (line.byteLength > maxFrameBytes) {
    throw new ProtocolError("frame_too_large", `Protocol frame exceeds ${maxFrameBytes} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
  } catch {
    throw new ProtocolError("invalid_json", "Protocol frame must be valid UTF-8 JSON");
  }
  assertValueLimits(value, 0);
  const record = asRecord(value, "frame");
  if (record["v"] !== PROTOCOL_VERSION) {
    throw new ProtocolError("unsupported_version", `Protocol version ${String(record["v"])} is unsupported`);
  }
  if (record["kind"] === "hello") return parseHello(record);
  if (record["kind"] === "command") return parseCommand(record);
  throw new ProtocolError("invalid_kind", "Client frame kind must be hello or command");
}

export function encodeFrame(frame: ServerFrame | ClientFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function toEventEnvelope(event: PublicKernelEvent, streamId: string, seq: number): EventEnvelope {
  return {
    v: PROTOCOL_VERSION,
    kind: "event",
    id: event.id,
    streamId,
    seq,
    ts: event.ts,
    durable: event.durable,
    type: event.type,
    payload: event.payload,
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
    ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
  };
}

export class ProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

function parseHello(record: Record<string, unknown>): ClientHelloFrame {
  exactKeys(record, ["v", "kind", "id", "clientId", "supportedVersions", "capabilities", "cursors"], "hello");
  const versions = numberArray(record["supportedVersions"], "supportedVersions");
  if (!versions.includes(PROTOCOL_VERSION)) {
    throw new ProtocolError("unsupported_version", "Client does not support protocol version 1");
  }
  const cursors = asRecord(record["cursors"], "cursors");
  const parsedCursors: Record<string, number> = {};
  for (const [streamId, seq] of Object.entries(cursors)) {
    parsedCursors[identifier(streamId, "cursor streamId")] = nonNegativeInteger(seq, `cursor ${streamId}`);
  }
  return {
    v: PROTOCOL_VERSION,
    kind: "hello",
    id: identifier(record["id"], "id"),
    clientId: identifier(record["clientId"], "clientId"),
    supportedVersions: versions,
    capabilities: stringArray(record["capabilities"], "capabilities"),
    cursors: parsedCursors,
  };
}

function parseCommand(record: Record<string, unknown>): CommandEnvelope {
  exactKeys(
    record,
    ["v", "kind", "id", "clientId", "sessionId", "expectedRevision", "type", "payload"],
    "command",
  );
  const sessionId = record["sessionId"];
  const expectedRevision = record["expectedRevision"];
  return {
    v: PROTOCOL_VERSION,
    kind: "command",
    id: identifier(record["id"], "id"),
    clientId: identifier(record["clientId"], "clientId"),
    type: eventType(record["type"]),
    payload: record["payload"],
    ...(sessionId === undefined ? {} : { sessionId: identifier(sessionId, "sessionId") }),
    ...(expectedRevision === undefined
      ? {}
      : { expectedRevision: nonNegativeInteger(expectedRevision, "expectedRevision") }),
  };
}

function assertValueLimits(value: unknown, depth: number): void {
  if (depth > DEFAULT_MAX_NESTING_DEPTH) {
    throw new ProtocolError("nesting_too_deep", `JSON nesting exceeds ${DEFAULT_MAX_NESTING_DEPTH}`);
  }
  if (typeof value === "string" && value.length > DEFAULT_MAX_STRING_LENGTH) {
    throw new ProtocolError("string_too_large", `JSON string exceeds ${DEFAULT_MAX_STRING_LENGTH} characters`);
  }
  if (Array.isArray(value)) {
    for (const item of value) assertValueLimits(item, depth + 1);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertValueLimits(key, depth + 1);
      assertValueLimits(item, depth + 1);
    }
  }
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !accepted.has(key));
  if (unknown.length > 0) {
    throw new ProtocolError("unknown_field", `${path} contains unknown fields: ${unknown.join(", ")}`);
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError("invalid_field", `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || /[\u0000-\u001f]/.test(value)) {
    throw new ProtocolError("invalid_field", `${path} must be a non-empty identifier of at most 128 characters`);
  }
  return value;
}

function eventType(value: unknown): string {
  const type = identifier(value, "type");
  if (!/^[a-z][a-z0-9_.-]*$/.test(type)) {
    throw new ProtocolError("invalid_field", "type contains unsupported characters");
  }
  return type;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new ProtocolError("invalid_field", `${path} must be an array with at most 128 entries`);
  }
  return value.map((item, index) => identifier(item, `${path}[${index}]`));
}

function numberArray(value: unknown, path: string): number[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw new ProtocolError("invalid_field", `${path} must be an array with at most 16 entries`);
  }
  return value.map((item, index) => nonNegativeInteger(item, `${path}[${index}]`));
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ProtocolError("invalid_field", `${path} must be a non-negative safe integer`);
  }
  return Number(value);
}
