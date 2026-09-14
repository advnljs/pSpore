import { MAX_PUBLISHED_STRING_CHARS } from "../protocol/limits.js";
import { decodeIndexingSettingsUpdate, } from "../settings/indexing-settings.js";
import { decodeLlmSettingsUpdate, } from "../settings/llm-settings.js";
export const DESKTOP_BOOTSTRAP_CHANNEL = "pspore:desktop:bootstrap";
export const DESKTOP_DISPATCH_CHANNEL = "pspore:desktop:dispatch";
export const DESKTOP_FRAME_CHANNEL = "pspore:desktop:frame";
export const DESKTOP_SETTINGS_GET_CHANNEL = "pspore:desktop:settings:get";
export const DESKTOP_SETTINGS_SAVE_CHANNEL = "pspore:desktop:settings:save";
export const DESKTOP_INDEXING_GET_CHANNEL = "pspore:desktop:indexing:get";
export const DESKTOP_INDEXING_SAVE_CHANNEL = "pspore:desktop:indexing:save";
export const DESKTOP_INDEXING_PICK_CHANNEL = "pspore:desktop:indexing:pick";
/**
 * Thrown before a command is written to the socket, so a caller may safely retry
 * it once the bridge reconnects. Never used for a command that was already sent.
 */
export const DAEMON_NOT_CONNECTED_MESSAGE = "pSpore daemon is not connected";
export function decodeDesktopIndexingSettingsUpdate(value) {
    return decodeIndexingSettingsUpdate(value, "desktop indexing settings");
}
export function decodeDesktopLlmSettingsUpdate(value) {
    return decodeLlmSettingsUpdate(value, "desktop LLM settings");
}
export function decodeDesktopCommand(value) {
    const input = object(value, "desktop command");
    const action = boundedString(input["action"], "desktop command.action", 64);
    switch (action) {
        case "prompt":
        case "steer":
        case "follow_up":
            exactKeys(input, ["action", "text", "sessionId"], action);
            return {
                action,
                text: boundedString(input["text"], `${action}.text`, 65_536),
                sessionId: identifier(input["sessionId"], `${action}.sessionId`),
            };
        case "abort":
        case "compact":
        case "session.delete":
            exactKeys(input, ["action", "sessionId"], action);
            return { action, sessionId: identifier(input["sessionId"], `${action}.sessionId`) };
        case "session.create": {
            exactKeys(input, ["action", "title"], action, ["title"]);
            const title = input["title"];
            return {
                action,
                ...(title === undefined ? {} : { title: boundedString(title, "session.create.title", 120) }),
            };
        }
        case "session.transcript": {
            exactKeys(input, ["action", "sessionId", "from", "limit"], action, ["from", "limit"]);
            const from = input["from"];
            const limit = input["limit"];
            return {
                action,
                sessionId: identifier(input["sessionId"], "session.transcript.sessionId"),
                ...(from === undefined ? {} : { from: nonNegativeInteger(from, "session.transcript.from", Number.MAX_SAFE_INTEGER) }),
                ...(limit === undefined ? {} : { limit: nonNegativeInteger(limit, "session.transcript.limit", 500) }),
            };
        }
        case "session.message": {
            exactKeys(input, ["action", "sessionId", "id", "index", "offset", "limit"], action, ["id", "index", "offset", "limit"]);
            const id = input["id"];
            const index = input["index"];
            const offset = input["offset"];
            const limit = input["limit"];
            if (id === undefined && index === undefined)
                throw new Error("session.message needs id or index");
            return {
                action,
                sessionId: identifier(input["sessionId"], "session.message.sessionId"),
                ...(id === undefined ? {} : { id: boundedString(id, "session.message.id", 200) }),
                ...(index === undefined ? {} : { index: nonNegativeInteger(index, "session.message.index", Number.MAX_SAFE_INTEGER) }),
                ...(offset === undefined ? {} : { offset: nonNegativeInteger(offset, "session.message.offset", Number.MAX_SAFE_INTEGER) }),
                ...(limit === undefined ? {} : { limit: nonNegativeInteger(limit, "session.message.limit", MAX_PUBLISHED_STRING_CHARS) }),
            };
        }
        case "queue.send-now":
            exactKeys(input, ["action", "sessionId", "index"], action);
            return {
                action,
                sessionId: identifier(input["sessionId"], "queue.send-now.sessionId"),
                index: nonNegativeInteger(input["index"], "queue.send-now.index", 10_000),
            };
        case "tools.list":
        case "jobs.list":
        case "runs.list":
        case "notifications.list":
        case "agents.list":
        case "mcp.servers":
        case "mcp.tools":
        case "resources.list":
        case "skills.list":
        case "skills.catalog":
        case "plugins.list":
            exactKeys(input, ["action"], action);
            return { action };
        case "approval.resolve": {
            exactKeys(input, ["action", "approvalId", "approved", "scope"], action);
            const approved = input["approved"];
            if (typeof approved !== "boolean")
                throw new Error("approval.resolve.approved must be boolean");
            return {
                action,
                approvalId: identifier(input["approvalId"], "approval.resolve.approvalId"),
                approved,
                scope: enumeration(input["scope"], ["once", "session", "job"], "approval.resolve.scope"),
            };
        }
        case "job.run":
            exactKeys(input, ["action", "jobId"], action);
            return { action, jobId: identifier(input["jobId"], "job.run.jobId") };
        case "run.cancel":
            exactKeys(input, ["action", "runId"], action);
            return { action, runId: identifier(input["runId"], "run.cancel.runId") };
        case "agent.spawn":
            exactKeys(input, ["action", "objective", "parentId"], action);
            return {
                action,
                objective: boundedString(input["objective"], "agent.spawn.objective", 16_384),
                parentId: identifier(input["parentId"], "agent.spawn.parentId"),
            };
        case "agent.send":
            exactKeys(input, ["action", "agentId", "message", "mode"], action);
            return {
                action,
                agentId: identifier(input["agentId"], "agent.send.agentId"),
                message: boundedString(input["message"], "agent.send.message", 65_536),
                mode: enumeration(input["mode"], ["steer", "follow_up", "next"], "agent.send.mode"),
            };
        case "agent.join":
            exactKeys(input, ["action", "agentIds"], action);
            return { action, agentIds: identifierArray(input["agentIds"], "agent.join.agentIds", 32) };
        case "agent.cancel":
            exactKeys(input, ["action", "agentId"], action);
            return { action, agentId: identifier(input["agentId"], "agent.cancel.agentId") };
        case "mcp.discover":
        case "mcp.ping":
            exactKeys(input, ["action", "serverId"], action);
            return { action, serverId: identifier(input["serverId"], `${action}.serverId`) };
        case "resources.inspect":
            exactKeys(input, ["action", "stagingName"], action);
            return { action, stagingName: resourceName(input["stagingName"], "resources.inspect.stagingName") };
        case "resources.install":
            exactKeys(input, ["action", "stagingName", "expectedDigest"], action);
            return {
                action,
                stagingName: resourceName(input["stagingName"], "resources.install.stagingName"),
                expectedDigest: digest(input["expectedDigest"], "resources.install.expectedDigest"),
            };
        case "resources.disable":
            exactKeys(input, ["action", "kind", "name", "expectedDigest"], action);
            return {
                action,
                kind: enumeration(input["kind"], ["skill", "host-plugin"], "resources.disable.kind"),
                name: identifier(input["name"], "resources.disable.name"),
                expectedDigest: digest(input["expectedDigest"], "resources.disable.expectedDigest"),
            };
        default:
            throw new Error(`Desktop action is not allowlisted: ${action}`);
    }
}
export function toProtocolInvocation(command, paths) {
    switch (command.action) {
        case "prompt":
            return { type: "session.prompt", payload: { text: command.text, mode: "auto" }, sessionId: command.sessionId };
        case "steer":
            return { type: "session.prompt", payload: { text: command.text, mode: "steer" }, sessionId: command.sessionId };
        case "follow_up":
            return { type: "session.prompt", payload: { text: command.text, mode: "follow_up" }, sessionId: command.sessionId };
        case "abort":
            return { type: "session.abort", payload: { reason: "Electron user requested abort" }, sessionId: command.sessionId };
        case "compact":
            return { type: "session.compact", payload: {}, sessionId: command.sessionId };
        case "session.create":
            return { type: "session.create", payload: command.title === undefined ? {} : { title: command.title } };
        case "session.delete":
            return { type: "session.delete", payload: {}, sessionId: command.sessionId };
        case "session.transcript":
            return {
                type: "session.transcript",
                payload: {
                    ...(command.from === undefined ? {} : { from: command.from }),
                    ...(command.limit === undefined ? {} : { limit: command.limit }),
                },
                sessionId: command.sessionId,
            };
        case "session.message":
            return {
                type: "session.message",
                payload: {
                    ...(command.id === undefined ? {} : { id: command.id }),
                    ...(command.index === undefined ? {} : { index: command.index }),
                    ...(command.offset === undefined ? {} : { offset: command.offset }),
                    ...(command.limit === undefined ? {} : { limit: command.limit }),
                },
                sessionId: command.sessionId,
            };
        case "queue.send-now":
            return { type: "session.queue.send-now", payload: { index: command.index }, sessionId: command.sessionId };
        case "approval.resolve":
            return {
                type: "approval.resolve",
                payload: { approvalId: command.approvalId, approved: command.approved, scope: command.scope },
            };
        case "tools.list":
        case "jobs.list":
        case "runs.list":
        case "notifications.list":
        case "agents.list":
        case "mcp.servers":
        case "mcp.tools":
        case "resources.list":
        case "skills.list":
        case "skills.catalog":
        case "plugins.list":
            return { type: command.action, payload: {} };
        case "job.run":
            return { type: "job.run", payload: { jobId: command.jobId } };
        case "run.cancel":
            return { type: "run.cancel", payload: { runId: command.runId, reason: "cancelled from Electron" } };
        case "agent.spawn":
            return {
                type: "agent.spawn",
                payload: {
                    parentId: command.parentId,
                    objective: command.objective,
                    workspaceMode: "shared-read",
                    budget: {
                        maxTurns: 8,
                        maxToolCalls: 24,
                        maxInputTokens: 50_000,
                        maxOutputTokens: 8_000,
                        maxChildren: 0,
                    },
                },
            };
        case "agent.send":
            return {
                type: "agent.send",
                payload: { agentId: command.agentId, message: command.message, mode: command.mode },
            };
        case "agent.join":
            return { type: "agent.join", payload: { agentIds: command.agentIds, timeoutMs: 300_000 } };
        case "agent.cancel":
            return { type: "agent.cancel", payload: { agentId: command.agentId, reason: "cancelled from Electron" } };
        case "mcp.discover":
            return { type: "mcp.discover", payload: { serverId: command.serverId } };
        case "mcp.ping":
            return { type: "mcp.ping", payload: { serverId: command.serverId } };
        case "resources.inspect":
            return { type: "resources.inspect", payload: { stagingPath: paths.stagingPath(command.stagingName) } };
        case "resources.install":
            return {
                type: "resources.install",
                payload: { stagingPath: paths.stagingPath(command.stagingName), expectedDigest: command.expectedDigest },
            };
        case "resources.disable":
            return {
                type: "resources.disable",
                payload: { kind: command.kind, name: command.name, expectedDigest: command.expectedDigest },
            };
    }
}
function object(value, path) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error(`${path} must be an object`);
    return value;
}
function exactKeys(value, keys, path, optional = []) {
    const expected = new Set(keys);
    const optionalKeys = new Set(optional);
    const unknown = Object.keys(value).filter((key) => !expected.has(key));
    if (unknown.length > 0)
        throw new Error(`${path} contains unknown fields: ${unknown.join(", ")}`);
    for (const key of keys)
        if (!optionalKeys.has(key) && !(key in value))
            throw new Error(`${path}.${key} is required`);
}
function boundedString(value, path, maximum) {
    if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000]/.test(value)) {
        throw new Error(`${path} must be a non-empty string of at most ${maximum} characters`);
    }
    return value;
}
function identifier(value, path) {
    const text = boundedString(value, path, 128);
    if (/[\u0000-\u001f]/.test(text))
        throw new Error(`${path} contains control characters`);
    return text;
}
function identifierArray(value, path, maximum) {
    if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
        throw new Error(`${path} must contain 1-${maximum} identifiers`);
    }
    const result = value.map((item, index) => identifier(item, `${path}[${index}]`));
    if (new Set(result).size !== result.length)
        throw new Error(`${path} must not contain duplicates`);
    return result;
}
function nonNegativeInteger(value, path, maximum) {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
        throw new Error(`${path} must be an integer between 0 and ${maximum}`);
    }
    return Number(value);
}
function resourceName(value, path) {
    const text = boundedString(value, path, 128);
    if (text === "." || text === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) {
        throw new Error(`${path} must be one top-level staging resource name`);
    }
    return text;
}
function digest(value, path) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
        throw new Error(`${path} must be a lowercase SHA-256`);
    return value;
}
function enumeration(value, allowed, path) {
    if (typeof value !== "string" || !allowed.includes(value))
        throw new Error(`${path} must be one of: ${allowed.join(", ")}`);
    return value;
}
//# sourceMappingURL=ipc-contract.js.map