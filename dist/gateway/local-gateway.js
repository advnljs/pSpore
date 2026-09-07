import { randomUUID } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { CommandError } from "../protocol/errors.js";
import { boundPublishedValue, measurePublishedValue } from "../protocol/limits.js";
import { DEFAULT_MAX_SERVER_MESSAGE_BYTES, encodeServerFrame, SERVER_FRAME_CHUNKS_CAPABILITY, } from "../protocol/server-frame-codec.js";
import { decodeClientFrame, DEFAULT_MAX_FRAME_BYTES, encodeFrame, PROTOCOL_VERSION, ProtocolError, toEventEnvelope, } from "../protocol/schema.js";
/**
 * Long agent runs push far more through a connection than an idle session does,
 * and a client that is busy rendering can legitimately fall a few megabytes
 * behind. Dropping it at that point is what surfaced as "lost connection" in
 * the middle of a task, so the ceiling is generous enough that only a client
 * which has genuinely stopped reading reaches it.
 */
const DEFAULT_MAX_OUTGOING_BYTES = 64 * 1_048_576;
/**
 * Durable events carry session snapshots, so a replay window counted only in
 * events retains one transcript copy per entry — hundreds of megabytes over a
 * long run. A reconnecting client whose cursor falls outside the window simply
 * takes the authoritative snapshot from the handshake instead, so trading
 * replay depth for bounded memory costs nothing but a little extra traffic.
 */
const DEFAULT_MAX_REPLAY_BYTES = 16 * 1_048_576;
export class LocalGateway {
    #socketPath;
    #instanceId;
    #snapshot;
    #handleCommand;
    #streamId;
    #replayCapacity;
    #commandCacheCapacity;
    #maxFrameBytes;
    #maxPendingBytes;
    #maxOutgoingBytes;
    #maxServerMessageBytes;
    #maxReplayBytes;
    #idFactory;
    #onWarning;
    #connections = new Set();
    #replay = [];
    #replayBytes = 0;
    #commandCache = new Map();
    #server;
    #seq = 0;
    constructor(options) {
        this.#socketPath = options.socketPath;
        this.#instanceId = options.instanceId;
        this.#snapshot = options.snapshot;
        this.#handleCommand = options.handleCommand;
        this.#streamId = options.streamId ?? "kernel";
        this.#replayCapacity = options.replayCapacity ?? 1_024;
        this.#commandCacheCapacity = options.commandCacheCapacity ?? 2_048;
        this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
        this.#maxPendingBytes = options.maxPendingBytes ?? this.#maxFrameBytes * 2;
        this.#maxOutgoingBytes = options.maxOutgoingBytes ?? DEFAULT_MAX_OUTGOING_BYTES;
        this.#maxServerMessageBytes = options.maxServerMessageBytes ?? DEFAULT_MAX_SERVER_MESSAGE_BYTES;
        this.#maxReplayBytes = options.maxReplayBytes ?? DEFAULT_MAX_REPLAY_BYTES;
        this.#idFactory = options.idFactory ?? randomUUID;
        this.#onWarning = options.onWarning ?? (() => undefined);
    }
    get latestSeq() {
        return this.#seq;
    }
    async start() {
        if (this.#server)
            throw new Error("Local gateway is already started");
        await removeOwnedSocket(this.#socketPath);
        const server = createServer((socket) => this.#accept(socket));
        this.#server = server;
        try {
            await new Promise((resolve, reject) => {
                const onError = (error) => {
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
        }
        catch (error) {
            this.#server = undefined;
            server.close();
            throw error;
        }
    }
    publish(event) {
        const bounded = measurePublishedValue(event.payload);
        const envelope = toEventEnvelope({ ...event, payload: bounded.value }, this.#streamId, ++this.#seq);
        if (event.durable) {
            this.#replay.push({ envelope, cost: bounded.cost });
            this.#replayBytes += bounded.cost;
            while (this.#replay.length > this.#replayCapacity
                || (this.#replayBytes > this.#maxReplayBytes && this.#replay.length > 1)) {
                this.#replayBytes -= this.#replay.shift()?.cost ?? 0;
            }
        }
        for (const connection of this.#connections) {
            if (!connection.authenticated)
                continue;
            this.#write(connection, envelope);
        }
        return envelope;
    }
    async stop() {
        const server = this.#server;
        if (!server)
            return;
        this.#server = undefined;
        for (const connection of this.#connections)
            connection.socket.destroy();
        await new Promise((resolve, reject) => server.close((error) => {
            if (error)
                reject(error);
            else
                resolve();
        }));
        await unlink(this.#socketPath).catch((error) => {
            if (!isNodeError(error) || error.code !== "ENOENT")
                throw error;
        });
    }
    #accept(socket) {
        socket.setNoDelay(true);
        const connection = {
            socket,
            authenticated: false,
            clientId: undefined,
            pending: Buffer.alloc(0),
            scanned: 0,
            processing: Promise.resolve(),
            supportsServerFrameChunks: false,
            failed: false,
            skippedEvents: 0,
        };
        this.#connections.add(connection);
        socket.on("data", (chunk) => this.#receive(connection, chunk));
        socket.on("error", () => undefined);
        socket.on("close", () => this.#connections.delete(connection));
    }
    #receive(connection, chunk) {
        if (connection.failed)
            return;
        connection.pending = Buffer.concat([connection.pending, chunk]);
        for (;;) {
            // Rescanning from byte zero on every read makes a large frame that
            // arrives in many small reads quadratic, which is exactly the shape of a
            // long run's traffic. Only the bytes that just arrived need scanning.
            const delimiter = connection.pending.indexOf(0x0a, connection.scanned);
            if (delimiter < 0) {
                connection.scanned = connection.pending.byteLength;
                break;
            }
            const line = connection.pending.subarray(0, delimiter);
            connection.pending = connection.pending.subarray(delimiter + 1);
            connection.scanned = 0;
            connection.processing = connection.processing
                .then(async () => this.#handleFrame(connection, line))
                .catch((error) => this.#protocolFailure(connection, normalizeProtocolError(error)));
        }
        if (connection.pending.byteLength > this.#maxPendingBytes) {
            this.#protocolFailure(connection, new ProtocolError("pending_bytes_exceeded", "Connection input buffer exceeded"));
            return;
        }
        if (connection.pending.byteLength > this.#maxFrameBytes) {
            this.#protocolFailure(connection, new ProtocolError("frame_too_large", "Protocol frame exceeded limit"));
        }
    }
    async #handleFrame(connection, line) {
        if (connection.failed)
            return;
        const frame = decodeClientFrame(line, this.#maxFrameBytes);
        if (!connection.authenticated) {
            if (frame.kind !== "hello")
                throw new ProtocolError("hello_required", "First frame must be hello");
            this.#hello(connection, frame);
            return;
        }
        if (frame.kind === "hello")
            throw new ProtocolError("duplicate_hello", "Connection is already authenticated");
        if (frame.clientId !== connection.clientId) {
            throw new ProtocolError("client_mismatch", "Command clientId does not match hello clientId");
        }
        await this.#command(connection, frame);
    }
    #hello(connection, hello) {
        connection.authenticated = true;
        connection.clientId = hello.clientId;
        connection.supportsServerFrameChunks = hello.capabilities.includes(SERVER_FRAME_CHUNKS_CAPABILITY);
        const cursor = hello.cursors[this.#streamId] ?? 0;
        const oldest = this.#replay[0]?.envelope.seq ?? this.#seq + 1;
        const acknowledgement = {
            v: PROTOCOL_VERSION,
            kind: "hello_ack",
            id: this.#idFactory(),
            protocolVersion: PROTOCOL_VERSION,
            instanceId: this.#instanceId,
            streamId: this.#streamId,
            latestSeq: this.#seq,
            replayFromSeq: oldest,
            // An unbounded snapshot is the one frame a client can never skip: it
            // rides on every reconnect, so a client that rejects it once rejects it
            // forever. Bounding it here keeps a huge session recoverable.
            snapshot: boundPublishedValue(this.#snapshot()),
        };
        this.#write(connection, acknowledgement);
        if (cursor >= oldest - 1) {
            for (const entry of this.#replay) {
                if (entry.envelope.seq > cursor)
                    this.#write(connection, entry.envelope);
            }
        }
    }
    async #command(connection, command) {
        const cacheKey = `${command.clientId}\0${command.id}`;
        const cached = this.#commandCache.get(cacheKey);
        if (cached) {
            this.#write(connection, cached);
            return;
        }
        let response;
        const currentRevision = this.#snapshot().revision;
        if (command.expectedRevision !== undefined && command.expectedRevision !== currentRevision) {
            response = this.#errorResponse(command.id, "revision_conflict", `Expected revision ${command.expectedRevision}, current revision is ${currentRevision}`, currentRevision);
        }
        else {
            try {
                const payload = await this.#handleCommand(command);
                response = {
                    v: PROTOCOL_VERSION,
                    kind: "response",
                    id: this.#idFactory(),
                    commandId: command.id,
                    ok: true,
                    payload: boundPublishedValue(payload),
                };
            }
            catch (error) {
                const normalized = error instanceof CommandError ? error : new CommandError("command_failed", toError(error).message);
                response = this.#errorResponse(command.id, normalized.code, normalized.message);
            }
        }
        this.#remember(cacheKey, response);
        this.#write(connection, response);
    }
    #errorResponse(commandId, code, message, currentRevision) {
        return {
            v: PROTOCOL_VERSION,
            kind: "response",
            id: this.#idFactory(),
            commandId,
            ok: false,
            error: { code, message, ...(currentRevision === undefined ? {} : { currentRevision }) },
        };
    }
    #remember(key, response) {
        this.#commandCache.set(key, response);
        if (this.#commandCache.size > this.#commandCacheCapacity) {
            const oldest = this.#commandCache.keys().next().value;
            if (oldest !== undefined)
                this.#commandCache.delete(oldest);
        }
    }
    #write(connection, frame) {
        if (connection.socket.destroyed)
            return;
        const transient = frame.kind === "event" && !frame.durable;
        // Transient frames are droppable by design; a client that cannot keep up sheds
        // them rather than being torn down, which is what used to make long runs
        // flap between connected and reconnecting.
        if (transient && connection.socket.writableNeedDrain) {
            connection.skippedEvents += 1;
            return;
        }
        if (connection.socket.writableLength > this.#maxOutgoingBytes) {
            if (transient) {
                connection.skippedEvents += 1;
                return;
            }
            this.#drop(connection, `client ${connection.clientId ?? "unknown"} stopped reading with `
                + `${connection.socket.writableLength} bytes queued`);
            return;
        }
        // Only an event can carry the pending skip count forward, so hello and
        // response frames must leave it untouched: clearing it there would strand
        // the client behind the sequence with nothing to explain the jump.
        const carriesSkip = frame.kind === "event" && connection.skippedEvents > 0;
        const outgoing = carriesSkip ? { ...frame, skipped: connection.skippedEvents } : frame;
        let encoded;
        try {
            encoded = connection.supportsServerFrameChunks
                ? encodeServerFrame(outgoing, {
                    maxFrameBytes: this.#maxFrameBytes,
                    maxMessageBytes: this.#maxServerMessageBytes,
                    idFactory: this.#idFactory,
                })
                : [encodeFrame(outgoing)];
        }
        catch (error) {
            // Encoding is per connection, but a failure here means this frame can
            // never reach this client. Dropping only the connection keeps the rest of
            // the broadcast — and the daemon — intact.
            this.#drop(connection, `frame ${frame.kind} could not be encoded: ${toError(error).message}`);
            return;
        }
        for (const chunk of encoded)
            connection.socket.write(chunk);
        if (frame.kind === "event")
            connection.skippedEvents = 0;
    }
    #drop(connection, reason) {
        this.#onWarning(`Dropped protocol connection: ${reason}`);
        connection.socket.destroy(new Error(reason));
    }
    #protocolFailure(connection, error) {
        if (connection.failed || connection.socket.destroyed)
            return;
        connection.failed = true;
        const response = this.#errorResponse("protocol", error.code, error.message);
        connection.socket.end(encodeFrame(response));
    }
}
async function removeOwnedSocket(path) {
    try {
        const metadata = await lstat(path);
        if (!metadata.isSocket())
            throw new Error(`Refusing to replace non-socket runtime path: ${path}`);
        await unlink(path);
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT")
            throw error;
    }
}
function normalizeProtocolError(error) {
    return error instanceof ProtocolError ? error : new ProtocolError("protocol_error", toError(error).message);
}
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
//# sourceMappingURL=local-gateway.js.map