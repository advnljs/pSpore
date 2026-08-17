import { applyCoworkActivityEvent } from "../shared/activity.js";
import { applyProtocolEvent, initialProtocolUiState, replaceProtocolSnapshot, selectProtocolSession, } from "../shared/protocol-state.js";
export class TuiStore {
    #state = {
        connected: false,
        ...initialProtocolUiState(),
        activities: [],
        notice: "Connecting to daemon…",
    };
    snapshot() {
        return structuredClone(this.#state);
    }
    applyHello(hello) {
        const cursors = { ...this.#state.cursors, [hello.streamId]: hello.latestSeq };
        const activities = this.#state.instanceId && this.#state.instanceId !== hello.instanceId ? [] : this.#state.activities;
        this.#state = {
            ...this.#state,
            ...replaceProtocolSnapshot(protocolState(this.#state), hello.snapshot, cursors),
            activities,
            connected: true,
            instanceId: hello.instanceId,
            notice: "Connected",
        };
        delete this.#state.gap;
    }
    disconnected(message) {
        this.#state = { ...this.#state, connected: false, notice: message };
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
        selectedSessionId: state.selectedSessionId,
        ...(state.gap ? { gap: state.gap } : {}),
    };
}
//# sourceMappingURL=store.js.map