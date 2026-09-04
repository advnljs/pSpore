import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import {
  DEFAULT_MAX_FRAME_BYTES,
  encodeFrame,
  PROTOCOL_VERSION,
  type ClientHelloFrame,
  type CommandEnvelope,
  type EventEnvelope,
  type ResponseEnvelope,
  type ServerFrame,
  type ServerHelloFrame,
} from "./schema.js";
import {
  DEFAULT_MAX_SERVER_MESSAGE_BYTES,
  ServerFrameDecoder,
  SERVER_FRAME_CHUNKS_CAPABILITY,
} from "./server-frame-codec.js";

export interface ProtocolClientOptions {
  socketPath: string;
  clientId: string;
  capabilities?: string[];
  cursors?: Record<string, number>;
  maxFrameBytes?: number;
  maxServerMessageBytes?: number;
  idFactory?: () => string;
}

interface PendingCommand {
  resolve: (response: ResponseEnvelope) => void;
  reject: (error: Error) => void;
}

export class ProtocolClient {
  readonly #options: ProtocolClientOptions;
  readonly #idFactory: () => string;
  readonly #decoder: ServerFrameDecoder;
  readonly #listeners = new Set<(event: EventEnvelope) => void>();
  readonly #connectionListeners = new Set<(connected: boolean, error?: Error) => void>();
  readonly #pendingCommands = new Map<string, PendingCommand>();
  #socket: Socket | undefined;
  #pending = Buffer.alloc(0);
  #helloWaiter: PendingCommand | undefined;
  #hello: ServerHelloFrame | undefined;
  #lastSeq: Record<string, number>;

  constructor(options: ProtocolClientOptions) {
    this.#options = options;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#decoder = new ServerFrameDecoder({
      maxFrameBytes: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      maxMessageBytes: options.maxServerMessageBytes ?? DEFAULT_MAX_SERVER_MESSAGE_BYTES,
    });
    this.#lastSeq = { ...(options.cursors ?? {}) };
  }

  get hello(): ServerHelloFrame | undefined {
    return this.#hello ? structuredClone(this.#hello) : undefined;
  }

  get cursors(): Record<string, number> {
    return { ...this.#lastSeq };
  }

  async connect(): Promise<ServerHelloFrame> {
    if (this.#socket) throw new Error("Protocol client is already connected");
    const socket = createConnection(this.#options.socketPath);
    this.#socket = socket;
    this.#pending = Buffer.alloc(0);
    this.#decoder.reset();
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    socket.on("error", (error) => this.#disconnect(error));
    socket.on("close", () => this.#disconnect(new Error("Protocol connection closed")));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const hello = new Promise<ServerHelloFrame>((resolve, reject) => {
      this.#helloWaiter = {
        resolve: (response) => reject(new Error(response.error?.message ?? "Handshake failed")),
        reject,
      };
      this.#resolveHello = resolve;
    });
    const capabilities = new Set(this.#options.capabilities ?? []);
    capabilities.add(SERVER_FRAME_CHUNKS_CAPABILITY);
    const frame: ClientHelloFrame = {
      v: PROTOCOL_VERSION,
      kind: "hello",
      id: this.#idFactory(),
      clientId: this.#options.clientId,
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: [...capabilities],
      cursors: this.cursors,
    };
    socket.write(encodeFrame(frame));
    return hello;
  }

  #resolveHello: ((hello: ServerHelloFrame) => void) | undefined;

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  subscribeConnection(listener: (connected: boolean, error?: Error) => void): () => void {
    this.#connectionListeners.add(listener);
    return () => this.#connectionListeners.delete(listener);
  }

  async command<T = unknown>(
    type: string,
    payload: unknown,
    options: { id?: string; sessionId?: string; expectedRevision?: number } = {},
  ): Promise<T> {
    const socket = this.#socket;
    if (!socket || socket.destroyed || !this.#hello) throw new Error("Protocol client is not connected");
    const id = options.id ?? this.#idFactory();
    const frame: CommandEnvelope = {
      v: PROTOCOL_VERSION,
      kind: "command",
      id,
      clientId: this.#options.clientId,
      type,
      payload,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
    };
    const response = new Promise<ResponseEnvelope>((resolve, reject) => {
      this.#pendingCommands.set(id, { resolve, reject });
    });
    socket.write(encodeFrame(frame));
    const result = await response;
    if (!result.ok) {
      const error = new Error(result.error?.message ?? "Protocol command failed");
      Object.assign(error, { code: result.error?.code, currentRevision: result.error?.currentRevision });
      throw error;
    }
    return result.payload as T;
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    if (!socket) return;
    this.#socket = undefined;
    if (socket.destroyed) return;
    await new Promise<void>((resolve) => socket.end(resolve));
  }

  #receive(chunk: Buffer): void {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    const maxFrameBytes = this.#options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    for (;;) {
      const delimiter = this.#pending.indexOf(0x0a);
      if (delimiter < 0) break;
      const line = this.#pending.subarray(0, delimiter);
      this.#pending = this.#pending.subarray(delimiter + 1);
      if (line.byteLength > maxFrameBytes) {
        this.#socket?.destroy(new Error("Server frame exceeded protocol limit"));
        return;
      }
      try {
        const frame = this.#decoder.decode(line);
        if (frame) this.#handleServerFrame(frame);
      } catch (error) {
        this.#socket?.destroy(toError(error));
        return;
      }
    }
    if (this.#pending.byteLength > maxFrameBytes) {
      this.#socket?.destroy(new Error("Server frame exceeded protocol limit"));
    }
  }

  #handleServerFrame(frame: ServerFrame): void {
    if (frame.kind === "hello_ack") {
      if (this.#hello) {
        this.#socket?.destroy(new Error("Server sent duplicate hello acknowledgement"));
        return;
      }
      this.#hello = structuredClone(frame);
      const resolve = this.#resolveHello;
      this.#resolveHello = undefined;
      this.#helloWaiter = undefined;
      resolve?.(this.hello as ServerHelloFrame);
      for (const listener of this.#connectionListeners) listener(true);
      return;
    }
    if (frame.kind === "event") {
      const previous = this.#lastSeq[frame.streamId] ?? 0;
      if (frame.seq > previous) this.#lastSeq[frame.streamId] = frame.seq;
      for (const listener of this.#listeners) listener(structuredClone(frame));
      return;
    }
    if (frame.kind === "response") {
      if (frame.commandId === "protocol" && this.#helloWaiter) {
        this.#helloWaiter.resolve(frame);
        this.#helloWaiter = undefined;
        return;
      }
      const pending = this.#pendingCommands.get(frame.commandId);
      if (!pending) return;
      this.#pendingCommands.delete(frame.commandId);
      pending.resolve(frame);
    }
  }

  #disconnect(error: Error): void {
    const wasConnected = this.#socket !== undefined || this.#hello !== undefined;
    this.#socket = undefined;
    this.#hello = undefined;
    this.#decoder.reset();
    this.#resolveHello = undefined;
    this.#helloWaiter?.reject(error);
    this.#helloWaiter = undefined;
    for (const pending of this.#pendingCommands.values()) pending.reject(error);
    this.#pendingCommands.clear();
    if (wasConnected) {
      for (const listener of this.#connectionListeners) listener(false, error);
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
