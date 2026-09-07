import { applyCoworkActivityEvent } from "../shared/activity.js";
import { applyProtocolEvent, initialProtocolUiState, replaceProtocolSnapshot, selectProtocolSession, } from "../shared/protocol-state.js";
/** Matches the desktop settle window so both shells report outages alike. */
export const TUI_CONNECTION_SETTLE_MS = 2_000;
export class TuiStore {
    #now;
    #unsettledSince;
    #everConnected = false;
    #state = {
        connected: false,
        reconnecting: false,
        ...initialProtocolUiState(),
        activities: [],
        notice: "Connecting to daemon…",
    };
    constructor(now = () => Date.now()) {
        this.#now = now;
    }
    /**
     * Re-checks the settle window from a timer so a real outage still surfaces
     * once the masking window expires. Returns true when the view changed.
     */
    settleConnection() {
        if (!this.#state.reconnecting)
            return false;
        if (this.#unsettledSince !== undefined && this.#now() - this.#unsettledSince < TUI_CONNECTION_SETTLE_MS)
            return false;
        this.#state = { ...this.#state, connected: false, reconnecting: false };
        return true;
    }
    snapshot() {
        // Protocol reducers replace state immutably and clone IPC payloads at the
        // boundary. Avoid copying every historical message on each terminal frame.
        return this.#state;
    }
    applyHello(hello) {
        const cursors = { ...this.#state.cursors, [hello.streamId]: hello.latestSeq };
        const activities = this.#state.instanceId && this.#state.instanceId !== hello.instanceId ? [] : this.#state.activities;
        this.#state = {
            ...this.#state,
            ...replaceProtocolSnapshot(protocolState(this.#state), hello.snapshot, cursors),
            activities,
            connected: true,
            reconnecting: false,
            instanceId: hello.instanceId,
            notice: "Connected",
        };
        delete this.#state.gap;
        this.#everConnected = true;
        this.#unsettledSince = undefined;
    }
    disconnected(message) {
        if (this.#unsettledSince === undefined)
            this.#unsettledSince = this.#now();
        // Long runs briefly drop and re-establish the socket. Masking that for the
        // settle window keeps the status line steady instead of flapping.
        const masked = this.#everConnected && this.#now() - this.#unsettledSince < TUI_CONNECTION_SETTLE_MS;
        this.#state = {
            ...this.#state,
            connected: masked,
            reconnecting: masked,
            ...(masked ? {} : { notice: message }),
        };
    }
    setNotice(notice) {
        this.#state = { ...this.#state, notice };
    }
    setConfiguredModel(model) {
        if (model)
            this.#state = { ...this.#state, configuredModel: { ...model } };
        else {
            const next = { ...this.#state };
            delete next.configuredModel;
            this.#state = next;
        }
    }
    setPanel(title, lines) {
        this.#state = { ...this.#state, panel: { title, lines: [...lines] }, notice: `${title} opened; use /back or Esc to return` };
    }
    clearPanel() {
        if (!this.#state.panel)
            return;
        const next = { ...this.#state };
        delete next.panel;
        this.#state = { ...next, notice: "Conversation view" };
    }
    selectSession(id) {
        const protocol = selectProtocolSession(protocolState(this.#state), id);
        this.#state = { ...this.#state, ...protocol, notice: `Selected ${id}` };
        return protocol.selectedSessionId;
    }
    applyEvent(event) {
        const result = applyProtocolEvent(protocolState(this.#state), event);
        const activities = result.applied
            ? applyCoworkActivityEvent(this.#state.activities, event)
            : this.#state.activities;
        this.#state = {
            ...this.#state,
            ...result.state,
            activities,
            ...(result.notificationNotice ? { notice: result.notificationNotice } : {}),
            ...(result.state.gap ? { notice: `Event gap detected on ${result.state.gap.streamId}; reconnecting for a snapshot` } : {}),
        };
    }
}
function protocolState(state) {
    return {
        kernel: state.kernel,
        cursors: state.cursors,
        streamingText: state.streamingText,
        streamingThinking: state.streamingThinking,
        selectedSessionId: state.selectedSessionId,
        ...(state.gap ? { gap: state.gap } : {}),
    };
}
//# sourceMappingURL=store.js.map