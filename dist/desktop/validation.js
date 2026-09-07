import { MAX_PROTOCOL_COLLECTION_ENTRIES, MAX_PROTOCOL_DEPTH, MAX_PROTOCOL_NODES, MAX_PROTOCOL_STRING_CHARS, } from "../protocol/limits.js";
/**
 * Ceilings for anything the daemon sends this process. They exist to stop a
 * broken peer from exhausting memory, not to police size: the daemon bounds its
 * own output far below them, so a frame that trips one of these is a defect
 * rather than a large session. Keeping the headroom wide matters because a
 * rejected authoritative snapshot cannot be skipped — it returns on every
 * reconnect and locks the client out for good.
 */
const MAX_DEPTH = MAX_PROTOCOL_DEPTH;
const MAX_NODES = MAX_PROTOCOL_NODES;
const MAX_STRING_LENGTH = MAX_PROTOCOL_STRING_CHARS;
const MAX_COLLECTION_ENTRIES = MAX_PROTOCOL_COLLECTION_ENTRIES;
const EVENT_TYPES = new Set([
    "daemon.state",
    "indexing.status",
    "session.snapshot",
    "session.closed",
    "session.replaced",
    "run.started",
    "run.settled",
    "message.started",
    "message.delta",
    "message.thinking.delta",
    "message.completed",
    "tool.started",
    "tool.updated",
    "tool.completed",
    "queue.updated",
    "compaction.started",
    "compaction.completed",
    "retry.started",
    "retry.completed",
    "runtime.error",
    "approval.requested",
    "approval.resolved",
    "automation.run",
    "notification.created",
    "agent.updated",
    "agent.message",
    "mcp.health",
    "resource.health",
]);
const RUNTIME_EVENT_TYPES = new Set([
    "session.replaced",
    "run.started",
    "run.settled",
    "message.started",
    "message.delta",
    "message.thinking.delta",
    "message.completed",
    "tool.started",
    "tool.updated",
    "tool.completed",
    "queue.updated",
    "compaction.started",
    "compaction.completed",
    "retry.started",
    "retry.completed",
    "runtime.error",
]);
export function validateKernelState(value) {
    assertSafeProtocolValue(value);
    const state = record(value, "kernel state");
    exactKeys(state, ["revision", "daemon", "sessions", "approvals", "runs", "notifications", "agents", "agentMessages", "mcpServers", "resources", "indexing"], "kernel state");
    nonNegativeInteger(state["revision"], "kernel state.revision");
    validateDaemon(state["daemon"]);
    validateSessionCollection(state["sessions"], "kernel state.sessions");
    validateRecordCollection(state["approvals"], "kernel state.approvals", "id");
    validateRecordCollection(state["runs"], "kernel state.runs", "id");
    validateArrayCollection(state["notifications"], "kernel state.notifications", "id");
    validateRecordCollection(state["agents"], "kernel state.agents", "id");
    validateArrayCollection(state["agentMessages"], "kernel state.agentMessages", "id");
    validateRecordCollection(state["mcpServers"], "kernel state.mcpServers", "serverId");
    validateRecordCollection(state["resources"], "kernel state.resources", "key");
    record(state["indexing"], "kernel state.indexing");
    return structuredClone(state);
}
export function validateServerHello(value) {
    assertSafeProtocolValue(value);
    const hello = record(value, "server hello");
    exactKeys(hello, ["v", "kind", "id", "protocolVersion", "instanceId", "streamId", "latestSeq", "replayFromSeq", "snapshot"], "server hello");
    if (hello["v"] !== 1 || hello["kind"] !== "hello_ack" || hello["protocolVersion"] !== 1) {
        throw new Error("Server hello has an unsupported protocol version or kind");
    }
    identifier(hello["id"], "server hello.id");
    identifier(hello["instanceId"], "server hello.instanceId");
    identifier(hello["streamId"], "server hello.streamId");
    nonNegativeInteger(hello["latestSeq"], "server hello.latestSeq");
    nonNegativeInteger(hello["replayFromSeq"], "server hello.replayFromSeq");
    validateKernelState(hello["snapshot"]);
    return structuredClone(hello);
}
export function validateEventEnvelope(value) {
    assertSafeProtocolValue(value);
    const event = record(value, "event");
    exactKeys(event, ["v", "kind", "id", "streamId", "seq", "ts", "correlationId", "causationId", "durable", "skipped", "type", "payload"], "event", ["correlationId", "causationId", "skipped"]);
    if (event["v"] !== 1 || event["kind"] !== "event")
        throw new Error("Event has an unsupported version or kind");
    identifier(event["id"], "event.id");
    identifier(event["streamId"], "event.streamId");
    nonNegativeInteger(event["seq"], "event.seq");
    boundedString(event["ts"], "event.ts", 64);
    optionalIdentifier(event["correlationId"], "event.correlationId");
    optionalIdentifier(event["causationId"], "event.causationId");
    if (typeof event["durable"] !== "boolean")
        throw new Error("event.durable must be boolean");
    if (event["skipped"] !== undefined)
        nonNegativeInteger(event["skipped"], "event.skipped");
    const type = boundedString(event["type"], "event.type", 128);
    if (!EVENT_TYPES.has(type))
        throw new Error(`Event type is not allowlisted: ${type}`);
    const payload = record(event["payload"], "event.payload");
    if (type === "message.delta" || type === "message.thinking.delta") {
        identifier(payload["sessionId"], "event.payload.sessionId");
        boundedString(payload["delta"], "event.payload.delta", MAX_STRING_LENGTH, true);
    }
    validateEventPayload(type, payload);
    return structuredClone(event);
}
export function validateProtocolResult(value) {
    if (value !== undefined)
        assertSafeProtocolValue(value);
    return structuredClone(value);
}
export function assertSafeProtocolValue(value) {
    const counter = { value: 0 };
    visit(value, 0, counter);
}
function visit(value, depth, counter) {
    counter.value += 1;
    if (counter.value > MAX_NODES)
        throw new Error(`Protocol value exceeds ${MAX_NODES} nodes`);
    if (depth > MAX_DEPTH)
        throw new Error(`Protocol value exceeds nesting depth ${MAX_DEPTH}`);
    if (value === null || typeof value === "boolean")
        return;
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new Error("Protocol value contains a non-finite number");
        return;
    }
    if (typeof value === "string") {
        if (value.length > MAX_STRING_LENGTH)
            throw new Error(`Protocol string exceeds ${MAX_STRING_LENGTH} characters`);
        return;
    }
    if (Array.isArray(value)) {
        if (value.length > MAX_COLLECTION_ENTRIES)
            throw new Error("Protocol array is too large");
        for (const item of value)
            visit(item, depth + 1, counter);
        return;
    }
    if (typeof value === "object") {
        const entries = Object.entries(value);
        if (entries.length > MAX_COLLECTION_ENTRIES)
            throw new Error("Protocol object is too large");
        for (const [key, item] of entries) {
            if (key.length > 256)
                throw new Error("Protocol object key is too long");
            visit(item, depth + 1, counter);
        }
        return;
    }
    throw new Error(`Protocol value contains unsupported ${typeof value}`);
}
function validateDaemon(value) {
    const daemon = record(value, "kernel state.daemon");
    exactKeys(daemon, ["phase", "instanceId", "startedAt", "error"], "kernel state.daemon", ["instanceId", "startedAt", "error"]);
    const phase = daemon["phase"];
    if (!new Set(["starting", "ready", "degraded", "draining", "failed", "stopped"]).has(phase)) {
        throw new Error("kernel state.daemon.phase is invalid");
    }
    optionalBoundedString(daemon["instanceId"], "kernel state.daemon.instanceId", 128);
    optionalBoundedString(daemon["startedAt"], "kernel state.daemon.startedAt", 64);
    optionalBoundedString(daemon["error"], "kernel state.daemon.error", 4_096);
}
function validateRecordCollection(value, path, identityField) {
    const collection = record(value, path);
    if (Object.keys(collection).length > MAX_COLLECTION_ENTRIES)
        throw new Error(`${path} is too large`);
    for (const [key, item] of Object.entries(collection)) {
        identifier(key, `${path} key`);
        const entry = record(item, `${path}.${key}`);
        const identity = identifier(entry[identityField], `${path}.${key}.${identityField}`);
        if (identity !== key)
            throw new Error(`${path}.${key}.${identityField} must match its collection key`);
    }
}
function validateSessionCollection(value, path) {
    const collection = record(value, path);
    if (Object.keys(collection).length > MAX_COLLECTION_ENTRIES)
        throw new Error(`${path} is too large`);
    for (const [key, item] of Object.entries(collection)) {
        identifier(key, `${path} key`);
        const sessionId = validateSessionView(item, `${path}.${key}`);
        if (sessionId !== key)
            throw new Error(`${path}.${key}.sessionId must match its collection key`);
    }
}
function validateArrayCollection(value, path, identityField) {
    if (!Array.isArray(value) || value.length > MAX_COLLECTION_ENTRIES)
        throw new Error(`${path} must be a bounded array`);
    for (const [index, item] of value.entries()) {
        const entry = record(item, `${path}[${index}]`);
        identifier(entry[identityField], `${path}[${index}].${identityField}`);
    }
}
function validateSessionView(value, path) {
    const snapshot = record(value, path);
    const sessionId = identifier(snapshot["sessionId"], `${path}.sessionId`);
    identifier(snapshot["upstreamSessionId"], `${path}.upstreamSessionId`);
    boundedString(snapshot["cwd"], `${path}.cwd`, 4_096);
    const status = snapshot["status"];
    if (status !== "idle" && status !== "running" && status !== "failed")
        throw new Error(`${path}.status is invalid`);
    // A view carries a bounded tail of the transcript plus where that tail sits,
    // so a client can tell "these are the newest 200 of 5000" from "this is all".
    validateMessageArray(snapshot["messages"], `${path}.messages`);
    nonNegativeInteger(snapshot["messageCount"], `${path}.messageCount`);
    nonNegativeInteger(snapshot["messageOffset"], `${path}.messageOffset`);
    optionalBoundedString(snapshot["firstUserText"], `${path}.firstUserText`, MAX_STRING_LENGTH);
    const queue = record(snapshot["queue"], `${path}.queue`);
    validateStringArray(queue["steering"], `${path}.queue.steering`);
    validateStringArray(queue["followUp"], `${path}.queue.followUp`);
    const usage = record(snapshot["usage"], `${path}.usage`);
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "total", "costUsd"]) {
        const amount = usage[field];
        if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)
            throw new Error(`${path}.usage.${field} is invalid`);
    }
    return sessionId;
}
function validateMessageArray(value, path) {
    if (!Array.isArray(value) || value.length > MAX_COLLECTION_ENTRIES)
        throw new Error(`${path} must be a bounded array`);
    for (const [index, item] of value.entries()) {
        const message = record(item, `${path}[${index}]`);
        boundedString(message["role"], `${path}[${index}].role`, 128);
        boundedString(message["text"], `${path}[${index}].text`, MAX_STRING_LENGTH, true);
    }
}
function validateStringArray(value, path) {
    if (!Array.isArray(value) || value.length > MAX_COLLECTION_ENTRIES)
        throw new Error(`${path} must be a bounded array`);
    for (const [index, item] of value.entries())
        boundedString(item, `${path}[${index}]`, MAX_STRING_LENGTH, true);
}
function validateEventPayload(type, payload) {
    if (RUNTIME_EVENT_TYPES.has(type)) {
        identifier(payload["sessionId"], "event.payload.sessionId");
        identifier(payload["upstreamSessionId"], "event.payload.upstreamSessionId");
        if (payload["session"] !== undefined)
            validateSessionView(payload["session"], "event.payload.session");
        optionalRevision(payload["revision"], "event.payload.revision");
        return;
    }
    switch (type) {
        case "daemon.state":
            validateDaemon(payload["daemon"]);
            requiredRevision(payload["revision"], "event.payload.revision");
            return;
        case "session.snapshot":
            validateSessionView(payload["session"], "event.payload.session");
            requiredRevision(payload["revision"], "event.payload.revision");
            return;
        case "session.closed":
            identifier(payload["sessionId"], "event.payload.sessionId");
            requiredRevision(payload["revision"], "event.payload.revision");
            return;
        case "approval.requested":
            validateIdentityObject(payload["request"], "event.payload.request", "id");
            requiredRevision(payload["revision"], "event.payload.revision");
            return;
        case "approval.resolved":
            identifier(payload["approvalId"], "event.payload.approvalId");
            record(payload["resolution"], "event.payload.resolution");
            requiredRevision(payload["revision"], "event.payload.revision");
            return;
        case "automation.run":
            validateIdentityObject(payload["run"], "event.payload.run", "id");
            requiredRevision(payload["revision"], "event.payload.revision");
            return;
        case "notification.created":
            validateIdentityObject(payload["notification"], "event.payload.notification", "id");
            requiredRevision(payload["revision"], "event.payload.revision");
            return;
        case "agent.updated":
            validateIdentityObject(payload["agent"], "event.payload.agent", "id");
            requiredRevision(payload["revision"], "event.payload.revision");
            return;
        case "agent.message":
            validateIdentityObject(payload["message"], "event.payload.message", "id");
            requiredRevision(payload["revision"], "event.payload.revision");
            return;
        case "mcp.health":
            validateIdentityObject(payload["health"], "event.payload.health", "serverId");
            requiredRevision(payload["revision"], "event.payload.revision");
            return;
        case "resource.health":
            validateIdentityObject(payload["health"], "event.payload.health", "key");
            requiredRevision(payload["revision"], "event.payload.revision");
    }
}
function validateIdentityObject(value, path, identityField) {
    const item = record(value, path);
    identifier(item[identityField], `${path}.${identityField}`);
}
function requiredRevision(value, path) {
    nonNegativeInteger(value, path);
}
function optionalRevision(value, path) {
    if (value !== undefined)
        requiredRevision(value, path);
}
function record(value, path) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error(`${path} must be an object`);
    return value;
}
function exactKeys(value, keys, path, optional = []) {
    const accepted = new Set(keys);
    const optionalSet = new Set(optional);
    const unknown = Object.keys(value).filter((key) => !accepted.has(key));
    if (unknown.length > 0)
        throw new Error(`${path} contains unknown fields: ${unknown.join(", ")}`);
    for (const key of keys) {
        if (!optionalSet.has(key) && !(key in value))
            throw new Error(`${path}.${key} is required`);
    }
}
function identifier(value, path) {
    const text = boundedString(value, path, 128);
    if (/[\u0000-\u001f]/.test(text))
        throw new Error(`${path} contains control characters`);
    return text;
}
function optionalIdentifier(value, path) {
    if (value !== undefined)
        identifier(value, path);
}
function boundedString(value, path, maximum, allowEmpty = false) {
    if (typeof value !== "string" || (!allowEmpty && !value) || value.length > maximum || /\u0000/.test(value)) {
        throw new Error(`${path} must be ${allowEmpty ? "a" : "a non-empty"} bounded string`);
    }
    return value;
}
function optionalBoundedString(value, path, maximum) {
    if (value !== undefined)
        boundedString(value, path, maximum);
}
function nonNegativeInteger(value, path) {
    if (!Number.isSafeInteger(value) || Number(value) < 0)
        throw new Error(`${path} must be a non-negative safe integer`);
    return Number(value);
}
//# sourceMappingURL=validation.js.map