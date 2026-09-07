import { applyProtocolDelta, applyProtocolEvent, initialProtocolUiState, replaceProtocolSnapshot, selectProtocolSession, } from "../../ui/shared/protocol-state.js";
import { applyCoworkActivityEvent, } from "../../ui/shared/activity.js";
/**
 * A reconnect that resolves inside this window is invisible to the user. Long
 * runs briefly drop and re-establish the socket; showing every one of those made
 * the header badge, banner and every connection-gated button flicker.
 */
export const CONNECTION_SETTLE_MS = 2_000;
export class DesktopStore {
    #now;
    /** Timestamp the current non-connected phase began, or undefined while connected. */
    #unsettledSince;
    #lastConnected;
    #state = {
        connection: { phase: "disconnected", attempt: 0, message: "Desktop is starting" },
        stableConnection: { phase: "disconnected", attempt: 0, message: "Desktop is starting" },
        reconnecting: false,
        ...initialProtocolUiState(),
        activities: [],
        notice: "正在启动 pSpore…",
    };
    constructor(now = () => Date.now()) {
        this.#now = now;
    }
    /**
     * Re-evaluates the settle window. The renderer calls this on a timer so a
     * genuine outage still surfaces even when no further frames arrive.
     * Returns true when the presented state changed.
     */
    settleConnection() {
        const stable = this.#stableConnection(this.#state.connection);
        const reconnecting = this.#isReconnecting(this.#state.connection);
        if (stable.phase === this.#state.stableConnection.phase
            && stable.message === this.#state.stableConnection.message
            && stable.instanceId === this.#state.stableConnection.instanceId
            && reconnecting === this.#state.reconnecting) {
            return false;
        }
        this.#state = { ...this.#state, stableConnection: stable, reconnecting };
        if (stable.phase !== "connected")
            this.#state = { ...this.#state, notice: connectionNotice(stable) };
        return true;
    }
    snapshot() {
        // Reducers replace state immutably and already clone untrusted IPC payloads.
        // Returning the current read model avoids cloning the complete transcript on
        // every streaming delta; renderer code treats this value as read-only.
        return this.#state;
    }
    applyBootstrap(bootstrap) {
        const protocol = bootstrap.snapshot
            ? replaceProtocolSnapshot(protocolState(this.#state), bootstrap.snapshot, bootstrap.cursors)
            : { ...protocolState(this.#state), cursors: { ...bootstrap.cursors } };
        this.#state = { ...this.#state, ...protocol };
        delete this.#state.gap;
        this.#setConnection(bootstrap.connection);
    }
    applyFrame(frame) {
        if (frame.kind === "connection") {
            this.#setConnection(frame.connection);
            return;
        }
        if (frame.kind === "snapshot") {
            this.#state = {
                ...this.#state,
                ...replaceProtocolSnapshot(protocolState(this.#state), frame.snapshot, frame.cursors),
                notice: "已加载守护进程权威快照",
            };
            delete this.#state.gap;
            return;
        }
        if (frame.kind === "delta") {
            const result = applyProtocolDelta(protocolState(this.#state), frame);
            this.#state = { ...this.#state, ...result.state, ...(result.state.gap ? { notice: gapNotice(result.state.gap) } : {}) };
            return;
        }
        this.#applyEvent(frame.event);
    }
    selectSession(id) {
        this.#state = { ...this.#state, ...selectProtocolSession(protocolState(this.#state), id), notice: `已切换到 ${id}` };
    }
    setNotice(notice) {
        this.#state = { ...this.#state, notice };
    }
    #setConnection(connection) {
        const next = structuredClone(connection);
        if (next.phase === "connected") {
            this.#unsettledSince = undefined;
            this.#lastConnected = next;
        }
        else if (this.#unsettledSince === undefined) {
            this.#unsettledSince = this.#now();
        }
        const stable = this.#stableConnection(next);
        const reconnecting = this.#isReconnecting(next);
        this.#state = {
            ...this.#state,
            connection: next,
            stableConnection: stable,
            reconnecting,
            // A blip inside the settle window keeps the previous notice, so the status
            // line does not flash "disconnected" and back during a long run.
            ...(reconnecting ? {} : { notice: connectionNotice(stable) }),
        };
    }
    #stableConnection(connection) {
        if (!this.#isReconnecting(connection))
            return connection;
        return structuredClone(this.#lastConnected);
    }
    /** True while a short outage is still being presented as a live connection. */
    #isReconnecting(connection) {
        if (connection.phase === "connected")
            return false;
        if (!this.#lastConnected || this.#unsettledSince === undefined)
            return false;
        return this.#now() - this.#unsettledSince < CONNECTION_SETTLE_MS;
    }
    #applyEvent(event) {
        const result = applyProtocolEvent(protocolState(this.#state), event);
        if (!result.applied) {
            this.#state = { ...this.#state, ...result.state, ...(result.state.gap ? { notice: gapNotice(result.state.gap) } : {}) };
            return;
        }
        const activities = applyCoworkActivityEvent(this.#state.activities, event);
        this.#state = {
            ...this.#state,
            ...result.state,
            activities,
            ...(result.notificationNotice ? { notice: result.notificationNotice } : {}),
        };
    }
}
function protocolState(state) {
    return {
        kernel: state.kernel,
        cursors: state.cursors,
        streamingText: state.streamingText,
        streamingThinking: state.streamingThinking,
        streamingItems: state.streamingItems,
        selectedSessionId: state.selectedSessionId,
        ...(state.gap ? { gap: state.gap } : {}),
    };
}
function gapNotice(gap) {
    return `事件流 ${gap.streamId} 出现缺口：期望 ${gap.expected}，收到 ${gap.received}；正在等待新的权威快照`;
}
function connectionNotice(connection) {
    if (connection.phase === "connected")
        return "已连接本地守护进程";
    return connection.message ?? (connection.phase === "connecting" ? "正在连接守护进程…" : "守护进程已断开");
}
//# sourceMappingURL=store.js.map