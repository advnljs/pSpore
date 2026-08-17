import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ProtocolClient } from "../protocol/client.js";
import { decodeDesktopCommand, toProtocolInvocation, } from "./ipc-contract.js";
import { validateEventEnvelope, validateKernelState, validateProtocolResult, validateServerHello } from "./validation.js";
export class DaemonBridge {
    #versions;
    #reconnectDelay;
    #clientFactory;
    #stagingRoot;
    #listeners = new Set();
    #connection = { phase: "disconnected", attempt: 0, message: "Daemon connection has not started" };
    #snapshot = null;
    #cursors = {};
    #client;
    #running = false;
    #loop;
    #wakeDisconnect;
    #pendingDelta;
    #deltaTimer;
    constructor(options) {
        this.#versions = structuredClone(options.versions);
        this.#stagingRoot = options.stagingRoot;
        this.#reconnectDelay = options.reconnectDelay ?? ((attempt) => Math.min(5_000, 250 * 2 ** Math.min(attempt - 1, 5)));
        const clientId = options.clientId ?? `electron-${process.pid}-${randomUUID()}`;
        this.#clientFactory =
            options.clientFactory ??
                ((cursors) => new ProtocolClient({
                    socketPath: options.socketPath,
                    clientId,
                    capabilities: ["desktop.v1", "delta.coalescing"],
                    cursors,
                }));
    }
    start() {
        if (this.#running)
            return;
        this.#running = true;
        this.#loop = this.#connectLoop();
    }
    async stop() {
        if (!this.#running && !this.#loop)
            return;
        this.#running = false;
        this.#flushDelta();
        this.#wakeDisconnect?.();
        await this.#client?.close().catch(() => undefined);
        await this.#loop;
        this.#loop = undefined;
        this.#setConnection({ phase: "disconnected", attempt: 0, message: "Desktop bridge stopped" });
    }
    bootstrap() {
        return {
            version: 1,
            connection: structuredClone(this.#connection),
            snapshot: this.#snapshot ? structuredClone(this.#snapshot) : null,
            cursors: { ...this.#cursors },
            versions: structuredClone(this.#versions),
        };
    }
    subscribe(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    async dispatch(value) {
        const command = decodeDesktopCommand(value);
        const client = this.#client;
        if (!client || this.#connection.phase !== "connected")
            throw new Error("pSpore daemon is not connected");
        const invocation = toProtocolInvocation(command, {
            stagingPath: (name) => join(this.#stagingRoot, name),
        });
        const result = await client.command(invocation.type, invocation.payload, {
            ...(invocation.sessionId === undefined ? {} : { sessionId: invocation.sessionId }),
        });
        return validateProtocolResult(result);
    }
    async #connectLoop() {
        let attempt = 0;
        while (this.#running) {
            attempt += 1;
            this.#setConnection({ phase: "connecting", attempt, message: attempt === 1 ? "Connecting to daemon…" : `Reconnect attempt ${attempt}` });
            const client = this.#clientFactory({ ...this.#cursors });
            this.#client = client;
            const bufferedEvents = [];
            let helloApplied = false;
            let disconnectError;
            let resolveDisconnect;
            const disconnected = new Promise((resolve) => {
                resolveDisconnect = resolve;
            });
            this.#wakeDisconnect = resolveDisconnect;
            const unsubscribeEvents = client.subscribe((event) => {
                if (!helloApplied) {
                    if (bufferedEvents.length >= 2_048)
                        void client.close();
                    else
                        bufferedEvents.push(event);
                }
                else
                    this.#handleEvent(client, event);
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
                for (const event of bufferedEvents)
                    this.#handleEvent(client, event);
                bufferedEvents.length = 0;
                attempt = 0;
                this.#setConnection({ phase: "connected", attempt: 0, instanceId: hello.instanceId });
                this.#emit({ version: 1, kind: "snapshot", snapshot: this.#snapshot, cursors: { ...this.#cursors } });
                await disconnected;
            }
            catch (error) {
                disconnectError = toError(error);
            }
            finally {
                this.#flushDelta();
                unsubscribeEvents();
                unsubscribeConnection();
                this.#wakeDisconnect = undefined;
                if (this.#client === client)
                    this.#client = undefined;
                await client.close().catch(() => undefined);
            }
            if (!this.#running)
                break;
            const message = disconnectError?.message ?? "Daemon connection closed";
            this.#setConnection({ phase: "disconnected", attempt: Math.max(1, attempt), message });
            await delay(this.#reconnectDelay(Math.max(1, attempt)));
        }
    }
    #handleEvent(client, candidate) {
        let event;
        try {
            event = validateEventEnvelope(candidate);
        }
        catch {
            void client.close();
            return;
        }
        const previous = this.#cursors[event.streamId] ?? 0;
        if (event.seq <= previous)
            return;
        if (event.seq !== previous + 1) {
            void client.close();
            return;
        }
        this.#cursors = { ...this.#cursors, [event.streamId]: event.seq };
        const payload = event.payload;
        if (event.type === "message.delta" && typeof payload["sessionId"] === "string" && typeof payload["delta"] === "string") {
            this.#queueDelta(event.streamId, event.seq, payload["sessionId"], payload["delta"]);
            return;
        }
        this.#flushDelta();
        this.#emit({ version: 1, kind: "event", event });
    }
    #queueDelta(streamId, seq, sessionId, text) {
        const pending = this.#pendingDelta;
        if (pending && pending.streamId === streamId && pending.sessionId === sessionId && seq === pending.seq + 1) {
            pending.seq = seq;
            pending.text += text;
        }
        else {
            this.#flushDelta();
            this.#pendingDelta = { streamId, fromSeq: seq, seq, sessionId, text };
        }
        if (!this.#deltaTimer)
            this.#deltaTimer = setTimeout(() => this.#flushDelta(), 30);
    }
    #flushDelta() {
        if (this.#deltaTimer)
            clearTimeout(this.#deltaTimer);
        this.#deltaTimer = undefined;
        const delta = this.#pendingDelta;
        this.#pendingDelta = undefined;
        if (!delta)
            return;
        this.#emit({ version: 1, kind: "delta", ...delta });
    }
    #setConnection(connection) {
        this.#connection = structuredClone(connection);
        this.#emit({ version: 1, kind: "connection", connection: this.#connection });
    }
    #emit(frame) {
        for (const listener of this.#listeners)
            listener(structuredClone(frame));
    }
}
function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
//# sourceMappingURL=daemon-bridge.js.map