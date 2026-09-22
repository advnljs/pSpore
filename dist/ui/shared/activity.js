export function applyCoworkActivityEvent(current, event, maximum = 100) {
    if (event.type !== "tool.started" && event.type !== "tool.updated" && event.type !== "tool.completed") {
        const generic = genericActivity(current, event);
        if (!generic)
            return current;
        const existing = current.findIndex((activity) => activity.id === generic.id);
        const activities = existing >= 0
            ? current.map((activity, index) => index === existing ? generic : activity)
            : [...current, generic];
        return activities.slice(-Math.max(1, maximum));
    }
    const payload = asRecord(event.payload);
    const toolCallId = stringValue(payload["toolCallId"]) ?? event.id;
    const toolName = stringValue(payload["toolName"]) ?? "tool";
    const sessionId = stringValue(payload["sessionId"]);
    const index = current.findIndex((activity) => activity.id === toolCallId);
    const previous = index >= 0 ? current[index] : undefined;
    let next;
    if (event.type === "tool.started") {
        const detail = activityDetail(payload["input"], undefined);
        next = {
            id: toolCallId,
            type: event.type,
            ...(sessionId ? { sessionId } : {}),
            toolName,
            status: "running",
            label: toolLabel(toolName, "running"),
            summary: toolTarget(toolName, asRecord(payload["input"])),
            ts: event.ts,
            ...(detail ? { detail } : {}),
        };
    }
    else if (event.type === "tool.updated") {
        if (!previous)
            return current;
        const detail = activityDetail(payload["partialResult"], previous.detail);
        next = {
            ...previous,
            type: event.type,
            ...(detail ? { detail } : {}),
        };
    }
    else {
        const failed = payload["isError"] === true;
        const startedAt = previous?.ts ?? event.ts;
        const detail = activityDetail(payload["result"], previous?.detail);
        next = {
            ...(previous ?? {
                id: toolCallId,
                ...(sessionId ? { sessionId } : {}),
                toolName,
                summary: toolTarget(toolName, {}),
                ts: startedAt,
            }),
            type: event.type,
            status: failed ? "failed" : "succeeded",
            label: toolLabel(toolName, failed ? "failed" : "succeeded"),
            completedAt: event.ts,
            durationMs: elapsedMs(startedAt, event.ts),
            resultSummary: toolResultSummary(toolName, payload["result"], failed),
            ...(detail ? { detail } : {}),
        };
    }
    const activities = index >= 0
        ? current.map((activity, activityIndex) => activityIndex === index ? next : activity)
        : [...current, next];
    return activities.slice(-Math.max(1, maximum));
}
function genericActivity(current, event) {
    const visible = new Set([
        "run.started",
        "run.settled",
        "compaction.started",
        "compaction.completed",
        "retry.started",
        "retry.completed",
        "runtime.error",
        "automation.run",
        "agent.updated",
        "agent.message",
        "mcp.health",
        "resource.health",
    ]);
    if (!visible.has(event.type))
        return undefined;
    const payload = asRecord(event.payload);
    const sessionId = stringValue(payload["sessionId"]);
    const pair = pairedEvent(event.type);
    const previous = pair?.phase === "completed"
        ? [...current].reverse().find((activity) => (activity.toolName === pair.key
            && activity.status === "running"
            && activity.sessionId === sessionId))
        : undefined;
    const presentation = genericPresentation(event.type, payload);
    const status = presentation.status;
    const detail = activityDetail(payload, previous?.detail);
    const startedAt = previous?.ts ?? event.ts;
    return {
        id: previous?.id ?? event.id,
        type: event.type,
        ...(sessionId ? { sessionId } : {}),
        toolName: pair?.key ?? presentation.kind,
        status,
        label: presentation.label,
        summary: presentation.summary,
        ts: startedAt,
        ...(status === "running" ? {} : {
            completedAt: event.ts,
            durationMs: elapsedMs(startedAt, event.ts),
        }),
        ...(presentation.result ? { resultSummary: presentation.result } : {}),
        ...(detail ? { detail } : {}),
    };
}
function pairedEvent(type) {
    if (type === "run.started")
        return { key: "run", phase: "started" };
    if (type === "run.settled")
        return { key: "run", phase: "completed" };
    if (type === "compaction.started")
        return { key: "compaction", phase: "started" };
    if (type === "compaction.completed")
        return { key: "compaction", phase: "completed" };
    if (type === "retry.started")
        return { key: "retry", phase: "started" };
    if (type === "retry.completed")
        return { key: "retry", phase: "completed" };
    return undefined;
}
function genericPresentation(type, payload) {
    if (type === "run.started")
        return { kind: "run", status: "running", label: "Working on request", summary: "cowork session" };
    if (type === "run.settled")
        return { kind: "run", status: "succeeded", label: "Request finished", summary: "cowork session" };
    if (type === "compaction.started") {
        return { kind: "compaction", status: "running", label: "Compacting context", summary: compactionReason(payload) };
    }
    if (type === "compaction.completed") {
        const aborted = payload["aborted"] === true;
        return {
            kind: "compaction",
            status: aborted ? "failed" : "succeeded",
            label: aborted ? "Context compaction stopped" : "Context compacted",
            summary: compactionReason(payload),
        };
    }
    if (type === "retry.started") {
        const attempt = numberValue(payload["attempt"]);
        const maximum = numberValue(payload["maxAttempts"]);
        return {
            kind: "retry",
            status: "running",
            label: "Retrying model request",
            summary: attempt === undefined ? "automatic retry" : `attempt ${attempt}${maximum === undefined ? "" : ` of ${maximum}`}`,
        };
    }
    if (type === "retry.completed") {
        const succeeded = payload["success"] === true;
        return {
            kind: "retry",
            status: succeeded ? "succeeded" : "failed",
            label: succeeded ? "Model retry succeeded" : "Model retry failed",
            summary: numberValue(payload["attempt"]) === undefined ? "automatic retry" : `attempt ${numberValue(payload["attempt"])}`,
        };
    }
    if (type === "runtime.error") {
        const error = stringValue(payload["message"]) ?? stringValue(payload["error"]) ?? "runtime reported an error";
        return { kind: "runtime", status: "failed", label: "Cowork task failed", summary: compactText(redactText(error), 140) };
    }
    const rootKey = type === "automation.run" ? "run"
        : type === "agent.updated" ? "agent"
            : type === "agent.message" ? "message"
                : "health";
    const record = asRecord(payload[rootKey]);
    const rawStatus = stringValue(record["status"]);
    const failed = rawStatus === "failed" || rawStatus === "degraded" || rawStatus === "blocked";
    const running = rawStatus === "running" || rawStatus === "active" || rawStatus === "starting" || rawStatus === "connecting";
    const status = failed ? "failed" : running ? "running" : "succeeded";
    const labels = {
        "automation.run": "Automation updated",
        "agent.updated": "Coworker updated",
        "agent.message": "Coworker message",
        "mcp.health": "Integration health changed",
        "resource.health": "Resource health changed",
    };
    const summary = stringValue(record["title"])
        ?? stringValue(record["name"])
        ?? stringValue(record["serverId"])
        ?? stringValue(record["key"])
        ?? stringValue(record["id"])
        ?? type.replaceAll(".", " ");
    return {
        kind: type,
        status,
        label: labels[type] ?? humanize(type),
        summary: compactText(summary, 120),
        ...(rawStatus ? { result: rawStatus } : {}),
    };
}
function compactionReason(payload) {
    const reason = stringValue(payload["reason"]);
    return reason === "token_threshold"
        ? "configured token threshold"
        : compactText(reason ?? "conversation context", 100);
}
export function toolLabel(toolName, status) {
    const labels = {
        read: ["Reading file", "Read file"],
        document: ["Reading document", "Read document"],
        article: ["Writing article", "Wrote article"],
        edit: ["Updating file", "Updated file"],
        search: ["Searching workspace", "Searched workspace"],
        shell: ["Running command", "Ran command"],
        memory_append: ["Saving daily memory", "Saved daily memory"],
        memory_curate: ["Curating long-term memory", "Curated long-term memory"],
        notify: ["Sending notification", "Sent notification"],
        schedule: ["Updating automation", "Updated automation"],
        agent_spawn: ["Starting coworker", "Started coworker"],
        agent_send: ["Messaging coworker", "Messaged coworker"],
        agent_join: ["Waiting for coworker", "Coworker finished"],
        mcp_call: ["Calling integration", "Called integration"],
        mcp_discover: ["Connecting integration", "Connected integration"],
    };
    const pair = labels[toolName];
    const completed = pair?.[1] ?? humanize(toolName);
    if (status === "failed")
        return `${completed} failed`;
    return status === "running" ? (pair?.[0] ?? `Using ${humanize(toolName)}`) : completed;
}
export function activityDetailLines(activity) {
    return [
        `Status     ${activity.status}`,
        `Step       ${activity.label}`,
        `Target     ${activity.summary}`,
        `Tool       ${activity.toolName ?? "n/a"}`,
        `Started    ${activity.ts}`,
        ...(activity.completedAt ? [`Completed  ${activity.completedAt}`] : []),
        ...(activity.durationMs === undefined ? [] : [`Duration   ${formatDuration(activity.durationMs)}`]),
        ...(activity.resultSummary ? [`Result     ${activity.resultSummary}`] : []),
        ...(activity.detail ? ["", "Technical details (redacted and size-limited)", activity.detail] : []),
    ];
}
export function formatDuration(durationMs) {
    if (durationMs < 1_000)
        return `${durationMs} ms`;
    if (durationMs < 60_000)
        return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
    const minutes = Math.floor(durationMs / 60_000);
    const seconds = Math.floor((durationMs % 60_000) / 1_000);
    return `${minutes}m ${seconds}s`;
}
function toolTarget(toolName, input) {
    if (toolName === "article")
        return stringValue(input["title"]) ?? stringValue(input["id"]) ?? "article";
    if (toolName === "read" || toolName === "document" || toolName === "edit") {
        return compactPath(stringValue(input["path"]) ?? "file");
    }
    if (toolName === "search") {
        const query = stringValue(input["query"]);
        const path = stringValue(input["path"]);
        return [query ? `“${compactText(query, 72)}”` : "workspace", path ? `in ${compactPath(path)}` : ""].filter(Boolean).join(" ");
    }
    if (toolName === "shell")
        return compactText(redactText(stringValue(input["command"]) ?? "command"), 110);
    if (toolName === "memory_append")
        return "durable daily note";
    if (toolName === "memory_curate") {
        const entries = Array.isArray(input["entries"]) ? input["entries"].length : undefined;
        return entries === undefined ? "MEMORY.md" : `${entries} long-term ${entries === 1 ? "fact" : "facts"}`;
    }
    if (toolName === "agent_spawn")
        return compactText(stringValue(input["objective"]) ?? "bounded task", 90);
    if (toolName === "agent_send" || toolName === "agent_join")
        return stringValue(input["agentId"]) ?? "coworker";
    if (toolName === "mcp_call") {
        return [stringValue(input["serverId"]), stringValue(input["toolName"])].filter(Boolean).join(" / ") || "integration";
    }
    return "work step";
}
function toolResultSummary(toolName, result, failed) {
    const root = asRecord(result);
    const details = asRecord(root["details"]);
    if (failed)
        return compactText(redactText(firstText(root) ?? "Tool reported an error"), 140);
    const bytes = numberValue(details["bytes"]);
    const returnedLines = numberValue(details["returnedLines"]);
    const added = numberValue(details["added"]);
    const capturedBytes = numberValue(details["capturedBytes"]);
    if (toolName === "edit" && bytes !== undefined)
        return `${formatBytes(bytes)} written`;
    if (toolName === "read" && returnedLines !== undefined)
        return `${returnedLines} lines read`;
    if (toolName === "memory_curate" && added !== undefined)
        return `${added} ${added === 1 ? "fact" : "facts"} added`;
    if (toolName === "shell" && capturedBytes !== undefined)
        return `${formatBytes(capturedBytes)} output captured`;
    const text = firstText(root);
    return text ? compactText(redactText(text), 120) : "Completed";
}
function activityDetail(value, previous) {
    if (value === undefined)
        return previous;
    try {
        const text = JSON.stringify(redactValue(value, 0), null, 2);
        const limited = text.length > 8_000 ? `${text.slice(0, 8_000)}\n… details folded at 8 KB` : text;
        return previous && previous !== limited ? `${previous}\n\nLatest update\n${limited}` : limited;
    }
    catch {
        return previous;
    }
}
function redactValue(value, depth) {
    if (depth > 8)
        return "[depth limited]";
    if (typeof value === "string")
        return redactText(value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value);
    if (Array.isArray(value))
        return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
    if (!isRecord(value))
        return value;
    const result = {};
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
        result[key] = /api.?key|token|password|secret|authorization|cookie/i.test(key)
            ? "[redacted]"
            : redactValue(child, depth + 1);
    }
    return result;
}
function redactText(value) {
    return value
        .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi, "$1[redacted]")
        .replace(/\b(?:sk|ds)-[A-Za-z0-9_-]{12,}\b/g, "[redacted credential]");
}
function firstText(result) {
    const content = result["content"];
    if (!Array.isArray(content))
        return undefined;
    for (const block of content) {
        const record = asRecord(block);
        if (typeof record["text"] === "string")
            return record["text"];
    }
    return undefined;
}
function elapsedMs(start, end) {
    const duration = new Date(end).getTime() - new Date(start).getTime();
    return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}
function compactPath(value) {
    const normalized = value.replaceAll("\\", "/");
    const parts = normalized.split("/").filter(Boolean);
    return parts.length <= 3 ? normalized : `…/${parts.slice(-3).join("/")}`;
}
function compactText(value, maximum) {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(1, maximum - 1))}…`;
}
function formatBytes(value) {
    if (value < 1_024)
        return `${value} B`;
    if (value < 1_048_576)
        return `${(value / 1_024).toFixed(1)} KB`;
    return `${(value / 1_048_576).toFixed(1)} MB`;
}
function humanize(value) {
    return value.replaceAll("__", " / ").replaceAll("_", " ").replaceAll(".", " ");
}
function stringValue(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function numberValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function asRecord(value) {
    return isRecord(value) ? value : {};
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=activity.js.map