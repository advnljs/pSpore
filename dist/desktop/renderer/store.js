import { applyProtocolDelta, applyProtocolEvent, initialProtocolUiState, replaceProtocolSnapshot, selectProtocolSession, } from "../../ui/shared/protocol-state.js";
import { applyCoworkActivityEvent, } from "../../ui/shared/activity.js";
export class DesktopStore {
    #state = {
        connection: { phase: "disconnected", attempt: 0, message: "Desktop is starting" },
        ...initialProtocolUiState(),
        activities: [],
        notice: "正在启动 pSpore…",
    };
    snapshot() {
        return structuredClone(this.#state);
    }
    applyBootstrap(bootstrap) {
        const protocol = bootstrap.snapshot
            ? replaceProtocolSnapshot(protocolState(this.#state), bootstrap.snapshot, bootstrap.cursors)
            : { ...protocolState(this.#state), cursors: { ...bootstrap.cursors } };
        this.#state = {
            ...this.#state,
            ...protocol,
            connection: structuredClone(bootstrap.connection),
            notice: connectionNotice(bootstrap.connection),
        };
        delete this.#state.gap;
    }
    applyFrame(frame) {
        if (frame.kind === "connection") {
            this.#state = {
                ...this.#state,
                connection: structuredClone(frame.connection),
                notice: connectionNotice(frame.connection),
            };
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