import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { DEFAULT_MAX_FRAME_BYTES, encodeFrame, PROTOCOL_VERSION, } from "./schema.js";
export class ProtocolClient {
    #options;
    #idFactory;
    #listeners = new Set();
    #connectionListeners = new Set();
    #pendingCommands = new Map();
    #socket;
    #pending = Buffer.alloc(0);
    #helloWaiter;
    #hello;
    #lastSeq;
    constructor(options) {
        this.#options = options;
        this.#idFactory = options.idFactory ?? randomUUID;
        this.#lastSeq = { ...(options.cursors ?? {}) };
    }
    get hello() {
        return this.#hello ? structuredClone(this.#hello) : undefined;
    }
    get cursors() {
        return { ...this.#lastSeq };
    }
    async connect() {
        if (this.#socket)
            throw new Error("Protocol client is already connected");
        const socket = createConnection(this.#options.socketPath);
        this.#socket = socket;
        this.#pending = Buffer.alloc(0);
        socket.setNoDelay(true);
        socket.on("data", (chunk) => this.#receive(chunk));
        socket.on("error", (error) => this.#disconnect(error));
        socket.on("close", () => this.#disconnect(new Error("Protocol connection closed")));
        await new Promise((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
        });
        const hello = new Promise((resolve, reject) => {
            this.#helloWaiter = {
                resolve: (response) => reject(new Error(response.error?.message ?? "Handshake failed")),
                reject,
            };
            this.#resolveHello = resolve;
        });
        const frame = {
            v: PROTOCOL_VERSION,
            kind: "hello",
            id: this.#idFactory(),
            clientId: this.#options.clientId,
            supportedVersions: [PROTOCOL_VERSION],
            capabilities: [...(this.#options.capabilities ?? [])],
            cursors: this.cursors,
        };
        socket.write(encodeFrame(frame));
        return hello;
    }
    #resolveHello;
    subscribe(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    subscribeConnection(listener) {
        this.#connectionListeners.add(listener);
        return () => this.#connectionListeners.delete(listener);
    }
    async command(type, payload, options = {}) {
        const socket = this.#socket;
        if (!socket || socket.destroyed || !this.#hello)
            throw new Error("Protocol client is not connected");
        const id = options.id ?? this.#idFactory();
        const frame = {
            v: PROTOCOL_VERSION,
            kind: "command",
            id,
            clientId: this.#options.clientId,
            type,
            payload,
            ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
        };
        const response = new Promise((resolve, reject) => {
            this.#pendingCommands.set(id, { resolve, reject });
        });
        socket.write(encodeFrame(frame));
        const result = await response;
        if (!result.ok) {
            const error = new Error(result.error?.message ?? "Protocol command failed");
            Object.assign(error, { code: result.error?.code, currentRevision: result.error?.currentRevision });
            throw error;
        }
        return result.payload;
    }
    async close() {
        const socket = this.#socket;
        if (!socket)
            return;
        this.#socket = undefined;
        if (socket.destroyed)
            return;
        await new Promise((resolve) => socket.end(resolve));
    }
    #receive(chunk) {
        this.#pending = Buffer.concat([this.#pending, chunk]);
        const maxFrameBytes = this.#options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
        if (this.#pending.byteLength > maxFrameBytes * 2) {
            this.#socket?.destroy(new Error("Server exceeded protocol buffer limit"));
            return;
        }
        for (;;) {
            const delimiter = this.#pending.indexOf(0x0a);
            if (delimiter < 0)
                break;
            const line = this.#pending.subarray(0, delimiter);
            this.#pending = this.#pending.subarray(delimiter + 1);
            if (line.byteLength > maxFrameBytes) {
                this.#socket?.destroy(new Error("Server frame exceeded protocol limit"));
                return;
            }
            this.#handleServerFrame(line);
        }
    }
    #handleServerFrame(line) {
        let frame;
        try {
            frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
        }
        catch {
            this.#socket?.destroy(new Error("Server sent invalid protocol JSON"));
            return;
        }
        if (frame.v !== PROTOCOL_VERSION) {
            this.#socket?.destroy(new Error("Server protocol version is unsupported"));
            return;
        }
        if (frame.kind === "hello_ack") {
            if (this.#hello) {
                this.#socket?.destroy(new Error("Server sent duplicate hello acknowledgement"));
                return;
            }
            this.#hello = structuredClone(frame);
            const resolve = this.#resolveHello;
            this.#resolveHello = undefined;
            this.#helloWaiter = undefined;
            resolve?.(this.hello);
            for (const listener of this.#connectionListeners)
                listener(true);
            return;
        }
        if (frame.kind === "event") {
            const previous = this.#lastSeq[frame.streamId] ?? 0;
            if (frame.seq > previous)
                this.#lastSeq[frame.streamId] = frame.seq;
            for (const listener of this.#listeners)
                listener(structuredClone(frame));
            return;
        }
        if (frame.kind === "response") {
            if (frame.commandId === "protocol" && this.#helloWaiter) {
                this.#helloWaiter.resolve(frame);
                this.#helloWaiter = undefined;
                return;
            }
            const pending = this.#pendingCommands.get(frame.commandId);
            if (!pending)
                return;
            this.#pendingCommands.delete(frame.commandId);
            pending.resolve(frame);
        }
    }
    #disconnect(error) {
        const wasConnected = this.#socket !== undefined || this.#hello !== undefined;
        this.#socket = undefined;
        this.#hello = undefined;
        this.#resolveHello = undefined;
        this.#helloWaiter?.reject(error);
        this.#helloWaiter = undefined;
        for (const pending of this.#pendingCommands.values())
            pending.reject(error);
        this.#pendingCommands.clear();
        if (wasConnected) {
            for (const listener of this.#connectionListeners)
                listener(false, error);
        }
    }
}
//# sourceMappingURL=client.js.map