import { randomUUID } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";

import type { KernelState, PublicKernelEvent } from "../kernel/state.js";
import { CommandError } from "../protocol/errors.js";
import {
  DEFAULT_MAX_SERVER_MESSAGE_BYTES,
  encodeServerFrame,
  SERVER_FRAME_CHUNKS_CAPABILITY,
} from "../protocol/server-frame-codec.js";
import {
  decodeClientFrame,
  DEFAULT_MAX_FRAME_BYTES,
  encodeFrame,
  PROTOCOL_VERSION,
  ProtocolError,
  toEventEnvelope,
  type ClientHelloFrame,
  type CommandEnvelope,
  type EventEnvelope,
  type ResponseEnvelope,
  type ServerHelloFrame,
} from "../protocol/schema.js";

export interface LocalGatewayOptions {
  socketPath: string;
  instanceId: string;
  snapshot: () => KernelState;
  handleCommand: (command: CommandEnvelope) => Promise<unknown>;
  streamId?: string;
  replayCapacity?: number;
  commandCacheCapacity?: number;
  maxFrameBytes?: number;
  maxPendingBytes?: number;
  maxServerMessageBytes?: number;
  idFactory?: () => string;
}

interface ConnectionState {
  socket: Socket;
  authenticated: boolean;
  clientId: string | undefined;
  pending: Buffer;
  processing: Promise<void>;
  supportsServerFrameChunks: boolean;
  failed: boolean;
  /**
   * Transient events this connection did not receive because its socket was
   * still draining. The count rides along on the next event so the client can
   * advance its cursor instead of reading the jump as a lost-event gap and
   * tearing the connection down mid-task.
   */
  skippedEvents: number;
}

export class LocalGateway {
  readonly #socketPath: string;
  readonly #instanceId: string;
  readonly #snapshot: () => KernelState;
  readonly #handleCommand: (command: CommandEnvelope) => Promise<unknown>;
  readonly #streamId: string;
  readonly #replayCapacity: number;
  readonly #commandCacheCapacity: number;
  readonly #maxFrameBytes: number;
  readonly #maxPendingBytes: number;
  readonly #maxServerMessageBytes: number;
  readonly #idFactory: () => string;
  readonly #connections = new Set<ConnectionState>();
  readonly #replay: EventEnvelope[] = [];
  readonly #commandCache = new Map<string, ResponseEnvelope>();
  #server: Server | undefined;
  #seq = 0;

  constructor(options: LocalGatewayOptions) {
    this.#socketPath = options.socketPath;
    this.#instanceId = options.instanceId;
    this.#snapshot = options.snapshot;
    this.#handleCommand = options.handleCommand;
    this.#streamId = options.streamId ?? "kernel";
    this.#replayCapacity = options.replayCapacity ?? 1_024;
    this.#commandCacheCapacity = options.commandCacheCapacity ?? 2_048;
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.#maxPendingBytes = options.maxPendingBytes ?? this.#maxFrameBytes * 2;
    this.#maxServerMessageBytes = options.maxServerMessageBytes ?? DEFAULT_MAX_SERVER_MESSAGE_BYTES;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  get latestSeq(): number {
    return this.#seq;
  }

  async start(): Promise<void> {
    if (this.#server) throw new Error("Local gateway is already started");
    await removeOwnedSocket(this.#socketPath);
    const server = createServer((socket) => this.#accept(socket));
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.#socketPath);
      });
      await chmod(this.#socketPath, 0o600);
    } catch (error) {
      this.#server = undefined;
      server.close();
      throw error;
    }
  }

  publish(event: PublicKernelEvent): EventEnvelope {
    const envelope = toEventEnvelope(event, this.#streamId, ++this.#seq);
    if (event.durable) {
      this.#replay.push(envelope);
      if (this.#replay.length > this.#replayCapacity) this.#replay.shift();
    }
    for (const connection of this.#connections) {
      if (!connection.authenticated) continue;
      this.#write(connection, envelope);
    }
    return envelope;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    for (const connection of this.#connections) connection.socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
    await unlink(this.#socketPath).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }

  #accept(socket: Socket): void {
    socket.setNoDelay(true);
    const connection: ConnectionState = {
      socket,
      authenticated: false,
      clientId: undefined,
      pending: Buffer.alloc(0),
      processing: Promise.resolve(),
      supportsServerFrameChunks: false,
      failed: false,
      skippedEvents: 0,
    };
    this.#connections.add(connection);
    socket.on("data", (chunk: Buffer) => this.#receive(connection, chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => this.#connections.delete(connection));
  }

  #receive(connection: ConnectionState, chunk: Buffer): void {
    if (connection.failed) return;
    connection.pending = Buffer.concat([connection.pending, chunk]);
    for (;;) {
      const delimiter = connection.pending.indexOf(0x0a);
      if (delimiter < 0) break;
      const line = connection.pending.subarray(0, delimiter);
      connection.pending = connection.pending.subarray(delimiter + 1);
      connection.processing = connection.processing
        .then(async () => this.#handleFrame(connection, line))
        .catch((error: unknown) => this.#protocolFailure(connection, normalizeProtocolError(error)));
    }
    if (connection.pending.byteLength > this.#maxPendingBytes) {
      this.#protocolFailure(connection, new ProtocolError("pending_bytes_exceeded", "Connection input buffer exceeded"));
      return;
    }
    if (connection.pending.byteLength > this.#maxFrameBytes) {
      this.#protocolFailure(connection, new ProtocolError("frame_too_large", "Protocol frame exceeded limit"));
    }
  }

  async #handleFrame(connection: ConnectionState, line: Uint8Array): Promise<void> {
    if (connection.failed) return;
    const frame = decodeClientFrame(line, this.#maxFrameBytes);
    if (!connection.authenticated) {
      if (frame.kind !== "hello") throw new ProtocolError("hello_required", "First frame must be hello");
      this.#hello(connection, frame);
      return;
    }
    if (frame.kind === "hello") throw new ProtocolError("duplicate_hello", "Connection is already authenticated");
    if (frame.clientId !== connection.clientId) {
      throw new ProtocolError("client_mismatch", "Command clientId does not match hello clientId");
    }
    await this.#command(connection, frame);
  }

  #hello(connection: ConnectionState, hello: ClientHelloFrame): void {
    connection.authenticated = true;
    connection.clientId = hello.clientId;
    connection.supportsServerFrameChunks = hello.capabilities.includes(SERVER_FRAME_CHUNKS_CAPABILITY);
    const cursor = hello.cursors[this.#streamId] ?? 0;
    const oldest = this.#replay[0]?.seq ?? this.#seq + 1;
    const acknowledgement: ServerHelloFrame = {
      v: PROTOCOL_VERSION,
      kind: "hello_ack",
      id: this.#idFactory(),
      protocolVersion: PROTOCOL_VERSION,
      instanceId: this.#instanceId,
      streamId: this.#streamId,
      latestSeq: this.#seq,
      replayFromSeq: oldest,
      snapshot: this.#snapshot(),
    };
    this.#write(connection, acknowledgement);
    if (cursor >= oldest - 1) {
      for (const event of this.#replay) {
        if (event.seq > cursor) this.#write(connection, event);
      }
    }
  }

  async #command(connection: ConnectionState, command: CommandEnvelope): Promise<void> {
    const cacheKey = `${command.clientId}\0${command.id}`;
    const cached = this.#commandCache.get(cacheKey);
    if (cached) {
      this.#write(connection, cached);
      return;
    }

    let response: ResponseEnvelope;
    const currentRevision = this.#snapshot().revision;
    if (command.expectedRevision !== undefined && command.expectedRevision !== currentRevision) {
      response = this.#errorResponse(
        command.id,
        "revision_conflict",
        `Expected revision ${command.expectedRevision}, current revision is ${currentRevision}`,
        currentRevision,
      );
    } else {
      try {
        const payload = await this.#handleCommand(command);
        response = {
          v: PROTOCOL_VERSION,
          kind: "response",
          id: this.#idFactory(),
          commandId: command.id,
          ok: true,
          payload,
        };
      } catch (error) {
        const normalized = error instanceof CommandError ? error : new CommandError("command_failed", toError(error).message);
        response = this.#errorResponse(command.id, normalized.code, normalized.message);
      }
    }
    this.#remember(cacheKey, response);
    this.#write(connection, response);
  }

  #errorResponse(commandId: string, code: string, message: string, currentRevision?: number): ResponseEnvelope {
    return {
      v: PROTOCOL_VERSION,
      kind: "response",
      id: this.#idFactory(),
      commandId,
      ok: false,
      error: { code, message, ...(currentRevision === undefined ? {} : { currentRevision }) },
    };
  }

  #remember(key: string, response: ResponseEnvelope): void {
    this.#commandCache.set(key, response);
    if (this.#commandCache.size > this.#commandCacheCapacity) {
      const oldest = this.#commandCache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#commandCache.delete(oldest);
    }
  }

  #write(connection: ConnectionState, frame: ServerHelloFrame | ResponseEnvelope | EventEnvelope): void {
    if (connection.socket.destroyed) return;
    const transient = frame.kind === "event" && !frame.durable;
    // Transient frames are droppable by design; a client that cannot keep up sheds
    // them rather than being torn down, which is what used to make long runs
    // flap between connected and reconnecting.
    if (transient && connection.socket.writableNeedDrain) {
      connection.skippedEvents += 1;
      return;
    }
    if (connection.socket.writableLength > this.#maxPendingBytes) {
      if (transient) {
        connection.skippedEvents += 1;
        return;
      }
      connection.socket.destroy(new Error("Protocol client is too slow"));
      return;
    }
    // Only an event can carry the pending skip count forward, so hello and
    // response frames must leave it untouched: clearing it there would strand
    // the client behind the sequence with nothing to explain the jump.
    const carriesSkip = frame.kind === "event" && connection.skippedEvents > 0;
    const outgoing = carriesSkip ? { ...frame, skipped: connection.skippedEvents } : frame;
    if (!connection.supportsServerFrameChunks) {
      connection.socket.write(encodeFrame(outgoing));
      if (frame.kind === "event") connection.skippedEvents = 0;
      return;
    }
    let encoded: readonly string[];
    try {
      encoded = encodeServerFrame(outgoing, {
        maxFrameBytes: this.#maxFrameBytes,
        maxMessageBytes: this.#maxServerMessageBytes,
        idFactory: this.#idFactory,
      });
    } catch (error) {
      connection.socket.destroy(toError(error));
      return;
    }
    for (const chunk of encoded) connection.socket.write(chunk);
    if (frame.kind === "event") connection.skippedEvents = 0;
  }

  #protocolFailure(connection: ConnectionState, error: ProtocolError): void {
    if (connection.failed || connection.socket.destroyed) return;
    connection.failed = true;
    const response = this.#errorResponse("protocol", error.code, error.message);
    connection.socket.end(encodeFrame(response));
  }
}

async function removeOwnedSocket(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isSocket()) throw new Error(`Refusing to replace non-socket runtime path: ${path}`);
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function normalizeProtocolError(error: unknown): ProtocolError {
  return error instanceof ProtocolError ? error : new ProtocolError("protocol_error", toError(error).message);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
