import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { ProtocolClient } from "../protocol/client.js";
import type { EventEnvelope, ServerHelloFrame } from "../protocol/schema.js";
import {
  DAEMON_NOT_CONNECTED_MESSAGE,
  decodeDesktopCommand,
  toProtocolInvocation,
  type DesktopBootstrap,
  type DesktopConnectionState,
  type DesktopFrame,
  type DesktopVersions,
} from "./ipc-contract.js";
import { validateEventEnvelope, validateKernelState, validateProtocolResult, validateServerHello } from "./validation.js";

interface ProtocolClientLike {
  connect(): Promise<ServerHelloFrame>;
  close(): Promise<void>;
  command<T = unknown>(
    type: string,
    payload: unknown,
    options?: { id?: string; sessionId?: string; expectedRevision?: number },
  ): Promise<T>;
  subscribe(listener: (event: EventEnvelope) => void): () => void;
  subscribeConnection(listener: (connected: boolean, error?: Error) => void): () => void;
}

export interface DaemonBridgeOptions {
  socketPath: string;
  stagingRoot: string;
  versions: DesktopVersions;
  clientId?: string;
  reconnectDelay?: (attempt: number) => number;
  clientFactory?: (cursors: Record<string, number>) => ProtocolClientLike;
}

interface PendingDelta {
  streamId: string;
  fromSeq: number;
  seq: number;
  /** Transient events the daemon shed immediately before `fromSeq`. */
  skipped: number;
  sessionId: string;
  channel: "text" | "thinking";
  text: string;
}

export class DaemonBridge {
  readonly #versions: DesktopVersions;
  readonly #reconnectDelay: (attempt: number) => number;
  readonly #clientFactory: (cursors: Record<string, number>) => ProtocolClientLike;
  readonly #stagingRoot: string;
  readonly #listeners = new Set<(frame: DesktopFrame) => void>();
  #connection: DesktopConnectionState = { phase: "disconnected", attempt: 0, message: "Daemon connection has not started" };
  #snapshot: DesktopBootstrap["snapshot"] = null;
  #cursors: Record<string, number> = {};
  #client: ProtocolClientLike | undefined;
  #running = false;
  #loop: Promise<void> | undefined;
  #wakeDisconnect: (() => void) | undefined;
  #pendingDelta: PendingDelta | undefined;
  #deltaTimer: NodeJS.Timeout | undefined;

  constructor(options: DaemonBridgeOptions) {
    this.#versions = structuredClone(options.versions);
    this.#stagingRoot = options.stagingRoot;
    this.#reconnectDelay = options.reconnectDelay ?? ((attempt) => Math.min(5_000, 250 * 2 ** Math.min(attempt - 1, 5)));
    const clientId = options.clientId ?? `electron-${process.pid}-${randomUUID()}`;
    this.#clientFactory =
      options.clientFactory ??
      ((cursors) =>
        new ProtocolClient({
          socketPath: options.socketPath,
          clientId,
          capabilities: ["desktop.v1", "delta.coalescing"],
          cursors,
        }));
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#loop = this.#connectLoop();
  }

  async stop(): Promise<void> {
    if (!this.#running && !this.#loop) return;
    this.#running = false;
    this.#flushDelta();
    this.#wakeDisconnect?.();
    await this.#client?.close().catch(() => undefined);
    await this.#loop;
    this.#loop = undefined;
    this.#setConnection({ phase: "disconnected", attempt: 0, message: "Desktop bridge stopped" });
  }

  bootstrap(): DesktopBootstrap {
    return {
      version: 1,
      connection: structuredClone(this.#connection),
      snapshot: this.#snapshot ? structuredClone(this.#snapshot) : null,
      cursors: { ...this.#cursors },
      versions: structuredClone(this.#versions),
    };
  }

  subscribe(listener: (frame: DesktopFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispatch(value: unknown): Promise<unknown> {
    const command = decodeDesktopCommand(value);
    const client = this.#client;
    if (!client || this.#connection.phase !== "connected") throw new Error(DAEMON_NOT_CONNECTED_MESSAGE);
    const invocation = toProtocolInvocation(command, {
      stagingPath: (name) => join(this.#stagingRoot, name),
    });
    const result = await client.command(invocation.type, invocation.payload, {
      ...(invocation.sessionId === undefined ? {} : { sessionId: invocation.sessionId }),
    });
    return validateProtocolResult(result);
  }

  async #connectLoop(): Promise<void> {
    let attempt = 0;
    while (this.#running) {
      attempt += 1;
      this.#setConnection({ phase: "connecting", attempt, message: attempt === 1 ? "Connecting to daemon…" : `Reconnect attempt ${attempt}` });
      const client = this.#clientFactory({ ...this.#cursors });
      this.#client = client;
      const bufferedEvents: EventEnvelope[] = [];
      let helloApplied = false;
      let disconnectError: Error | undefined;
      let resolveDisconnect!: () => void;
      const disconnected = new Promise<void>((resolve) => {
        resolveDisconnect = resolve;
      });
      this.#wakeDisconnect = resolveDisconnect;
      const unsubscribeEvents = client.subscribe((event) => {
        if (!helloApplied) {
          if (bufferedEvents.length >= 2_048) void client.close();
          else bufferedEvents.push(event);
        }
        else this.#handleEvent(client, event);
      });
      const unsubscribeConnection = client.subscribeConnection((connected, error) => {
        if (!connected) {
          disconnectError = error;
          resolveDisconnect();
        }
      });
      try {
        const hello = validateServerHello(await client.connect());
        this.#snapshot = validateKernelState(hello.snapshot);
        this.#cursors = { ...this.#cursors, [hello.streamId]: hello.latestSeq };
        helloApplied = true;
        for (const event of bufferedEvents) this.#handleEvent(client, event);
        bufferedEvents.length = 0;
        attempt = 0;
        this.#setConnection({ phase: "connected", attempt: 0, instanceId: hello.instanceId });
        this.#emit({ version: 1, kind: "snapshot", snapshot: this.#snapshot, cursors: { ...this.#cursors } });
        await disconnected;
      } catch (error) {
        disconnectError = toError(error);
      } finally {
        this.#flushDelta();
        unsubscribeEvents();
        unsubscribeConnection();
        this.#wakeDisconnect = undefined;
        if (this.#client === client) this.#client = undefined;
        await client.close().catch(() => undefined);
      }
      if (!this.#running) break;
      const message = disconnectError?.message ?? "Daemon connection closed";
      this.#setConnection({ phase: "disconnected", attempt: Math.max(1, attempt), message });
      await delay(this.#reconnectDelay(Math.max(1, attempt)));
    }
  }

  #handleEvent(client: ProtocolClientLike, candidate: EventEnvelope): void {
    let event: EventEnvelope;
    try {
      event = validateEventEnvelope(candidate);
    } catch {
      void client.close();
      return;
    }
    const previous = this.#cursors[event.streamId] ?? 0;
    if (event.seq <= previous) return;
    // `skipped` counts transient events the daemon deliberately shed under
    // backpressure. Only a jump beyond that is a real loss worth reconnecting for.
    const expected = previous + 1 + (event.skipped ?? 0);
    if (event.seq !== expected) {
      void client.close();
      return;
    }
    this.#cursors = { ...this.#cursors, [event.streamId]: event.seq };
    const payload = event.payload as Record<string, unknown>;
    const channel = event.type === "message.delta" ? "text"
      : event.type === "message.thinking.delta" ? "thinking"
        : undefined;
    if (channel && typeof payload["sessionId"] === "string" && typeof payload["delta"] === "string") {
      this.#queueDelta(event.streamId, event.seq, event.skipped ?? 0, payload["sessionId"], channel, payload["delta"]);
      return;
    }
    this.#flushDelta();
    this.#emit({ version: 1, kind: "event", event });
  }

  #queueDelta(
    streamId: string,
    seq: number,
    skipped: number,
    sessionId: string,
    channel: "text" | "thinking",
    text: string,
  ): void {
    const pending = this.#pendingDelta;
    if (
      pending
      && pending.streamId === streamId
      && pending.sessionId === sessionId
      && pending.channel === channel
      && seq === pending.seq + 1 + skipped
    ) {
      pending.seq = seq;
      pending.text += text;
    } else {
      this.#flushDelta();
      this.#pendingDelta = { streamId, fromSeq: seq, seq, skipped, sessionId, channel, text };
    }
    if (!this.#deltaTimer) this.#deltaTimer = setTimeout(() => this.#flushDelta(), 30);
  }

  #flushDelta(): void {
    if (this.#deltaTimer) clearTimeout(this.#deltaTimer);
    this.#deltaTimer = undefined;
    const delta = this.#pendingDelta;
    this.#pendingDelta = undefined;
    if (!delta) return;
    const { skipped, ...frame } = delta;
    this.#emit({ version: 1, kind: "delta", ...frame, ...(skipped > 0 ? { skipped } : {}) });
  }

  #setConnection(connection: DesktopConnectionState): void {
    this.#connection = structuredClone(connection);
    this.#emit({ version: 1, kind: "connection", connection: this.#connection });
  }

  #emit(frame: DesktopFrame): void {
    for (const listener of this.#listeners) listener(structuredClone(frame));
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
