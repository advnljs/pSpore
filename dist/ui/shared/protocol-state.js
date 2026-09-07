import { initialKernelState } from "../../kernel/state.js";
export function initialProtocolUiState() {
    return {
        kernel: initialKernelState(),
        cursors: {},
        streamingText: {},
        streamingThinking: {},
        selectedSessionId: "main",
    };
}
export function replaceProtocolSnapshot(current, kernel, cursors) {
    return {
        kernel: structuredClone(kernel),
        cursors: { ...cursors },
        streamingText: {},
        streamingThinking: {},
        selectedSessionId: selectAvailable(current.selectedSessionId, kernel),
    };
}
export function selectProtocolSession(current, id) {
    const sessionId = current.kernel.sessions[id] ? id : current.kernel.agents[id]?.sessionId;
    if (!sessionId || !current.kernel.sessions[sessionId])
        throw new Error(`Session is not active: ${id}`);
    return { ...current, selectedSessionId: sessionId };
}
export function applyProtocolDelta(current, delta) {
    const previous = current.cursors[delta.streamId] ?? 0;
    if (delta.seq <= previous)
        return { state: current, applied: false };
    const expected = previous + 1 + (delta.skipped ?? 0);
    if (delta.fromSeq !== expected || delta.seq < delta.fromSeq) {
        return { state: withGap(current, delta.streamId, expected, delta.fromSeq), applied: false };
    }
    const field = delta.channel === "thinking" ? "streamingThinking" : "streamingText";
    const values = current[field];
    return {
        state: {
            ...current,
            cursors: { ...current.cursors, [delta.streamId]: delta.seq },
            [field]: {
                ...values,
                [delta.sessionId]: `${values[delta.sessionId] ?? ""}${delta.text}`,
            },
        },
        applied: true,
    };
}
export function applyProtocolEvent(current, event) {
    const previous = current.cursors[event.streamId] ?? 0;
    if (event.seq <= previous)
        return { state: current, applied: false };
    // Transient events the daemon shed under backpressure are announced through
    // `skipped`, so the cursor jumps forward without being treated as data loss.
    const expected = previous + 1 + (event.skipped ?? 0);
    if (event.seq !== expected) {
        return { state: withGap(current, event.streamId, expected, event.seq), applied: false };
    }
    const payload = asRecord(event.payload);
    let kernel = current.kernel;
    let streamingText = current.streamingText;
    let streamingThinking = current.streamingThinking;
    if (event.type === "daemon.state") {
        const daemon = payload["daemon"];
        if (isRecord(daemon) && typeof daemon["phase"] === "string" && typeof payload["revision"] === "number") {
            kernel = { ...kernel, daemon: daemon, revision: payload["revision"] };
        }
    }
    const session = payload["session"];
    if (isAgentSnapshot(session)) {
        kernel = {
            ...kernel,
            revision: numericRevision(payload, kernel.revision),
            sessions: { ...kernel.sessions, [session.sessionId]: structuredClone(session) },
        };
    }
    if (event.type === "session.closed" && typeof payload["sessionId"] === "string") {
        const sessions = { ...kernel.sessions };
        delete sessions[payload["sessionId"]];
        streamingText = withoutSession(streamingText, payload["sessionId"]);
        streamingThinking = withoutSession(streamingThinking, payload["sessionId"]);
        kernel = { ...kernel, revision: numericRevision(payload, kernel.revision), sessions };
    }
    if (event.type === "message.delta" && typeof payload["sessionId"] === "string" && typeof payload["delta"] === "string") {
        streamingText = {
            ...streamingText,
            [payload["sessionId"]]: `${streamingText[payload["sessionId"]] ?? ""}${payload["delta"]}`,
        };
    }
    if (event.type === "message.thinking.delta" && typeof payload["sessionId"] === "string" && typeof payload["delta"] === "string") {
        streamingThinking = {
            ...streamingThinking,
            [payload["sessionId"]]: `${streamingThinking[payload["sessionId"]] ?? ""}${payload["delta"]}`,
        };
    }
    const streamSessionId = typeof payload["sessionId"] === "string" ? payload["sessionId"] : undefined;
    const startsAssistantMessage = event.type === "message.started" && payload["role"] === "assistant";
    const finishesStreaming = event.type === "message.completed"
        || event.type === "run.settled"
        || event.type === "runtime.error"
        || event.type === "session.replaced";
    if (streamSessionId && (startsAssistantMessage || finishesStreaming)) {
        streamingText = withoutSession(streamingText, streamSessionId);
        streamingThinking = withoutSession(streamingThinking, streamSessionId);
    }
    if (event.type === "approval.requested" && isRecord(payload["request"]) && typeof payload["request"]["id"] === "string") {
        const request = payload["request"];
        kernel = {
            ...kernel,
            revision: numericRevision(payload, kernel.revision),
            approvals: { ...kernel.approvals, [request.id]: structuredClone(request) },
        };
    }
    if (event.type === "approval.resolved" && typeof payload["approvalId"] === "string") {
        const approvals = { ...kernel.approvals };
        delete approvals[payload["approvalId"]];
        kernel = { ...kernel, revision: numericRevision(payload, kernel.revision), approvals };
    }
    if (event.type === "automation.run" && isRecord(payload["run"]) && typeof payload["run"]["id"] === "string") {
        const run = payload["run"];
        kernel = { ...kernel, revision: numericRevision(payload, kernel.revision), runs: { ...kernel.runs, [run.id]: structuredClone(run) } };
    }
    let notificationNotice;
    if (event.type === "notification.created" && isRecord(payload["notification"]) && typeof payload["notification"]["id"] === "string") {
        const notification = payload["notification"];
        kernel = {
            ...kernel,
            revision: numericRevision(payload, kernel.revision),
            notifications: [...kernel.notifications, structuredClone(notification)].slice(-200),
        };
        notificationNotice = `${notification.title}: ${notification.body}`;
    }
    if (event.type === "agent.updated" && isRecord(payload["agent"]) && typeof payload["agent"]["id"] === "string") {
        const agent = payload["agent"];
        kernel = { ...kernel, revision: numericRevision(payload, kernel.revision), agents: { ...kernel.agents, [agent.id]: structuredClone(agent) } };
    }
    if (event.type === "agent.message" && isRecord(payload["message"]) && typeof payload["message"]["id"] === "string") {
        const message = payload["message"];
        kernel = {
            ...kernel,
            revision: numericRevision(payload, kernel.revision),
            agentMessages: [...kernel.agentMessages, structuredClone(message)].slice(-500),
        };
    }
    if (event.type === "mcp.health" && isRecord(payload["health"]) && typeof payload["health"]["serverId"] === "string") {
        const health = payload["health"];
        kernel = { ...kernel, revision: numericRevision(payload, kernel.revision), mcpServers: { ...kernel.mcpServers, [health.serverId]: structuredClone(health) } };
    }
    if (event.type === "resource.health" && isRecord(payload["health"]) && typeof payload["health"]["key"] === "string") {
        const health = payload["health"];
        kernel = { ...kernel, revision: numericRevision(payload, kernel.revision), resources: { ...kernel.resources, [health.key]: structuredClone(health) } };
    }
    return {
        state: {
            ...current,
            kernel,
            cursors: { ...current.cursors, [event.streamId]: event.seq },
            streamingText,
            streamingThinking,
            selectedSessionId: selectAvailable(current.selectedSessionId, kernel),
        },
        applied: true,
        ...(notificationNotice ? { notificationNotice } : {}),
    };
}
function withoutSession(values, sessionId) {
    if (!(sessionId in values))
        return values;
    const next = { ...values };
    delete next[sessionId];
    return next;
}
function withGap(current, streamId, expected, received) {
    return { ...current, gap: { streamId, expected, received } };
}
function numericRevision(payload, fallback) {
    return typeof payload["revision"] === "number" ? payload["revision"] : fallback;
}
function selectAvailable(selected, kernel) {
    if (kernel.sessions[selected])
        return selected;
    return kernel.sessions["main"] ? "main" : (Object.keys(kernel.sessions)[0] ?? "main");
}
function asRecord(value) {
    return isRecord(value) ? value : {};
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isAgentSnapshot(value) {
    return (isRecord(value)
        && typeof value["sessionId"] === "string"
        && typeof value["upstreamSessionId"] === "string"
        && typeof value["cwd"] === "string"
        && (value["status"] === "idle" || value["status"] === "running" || value["status"] === "failed")
        && Array.isArray(value["messages"]));
}
//# sourceMappingURL=protocol-state.js.map