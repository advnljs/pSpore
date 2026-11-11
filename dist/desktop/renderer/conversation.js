import { t } from "./i18n.js";
export function isToolMessage(message) {
    return message.role === "tool" || message.role === "toolResult";
}
/** Group only consecutive work; user messages and final answers are boundaries. */
export function conversationRows(messages, offset, running) {
    const rows = [];
    let process;
    const add = (entry) => {
        if (!process) {
            process = { kind: "process", key: `process:${entry.index}`, entries: [], active: false };
            rows.push(process);
        }
        process.entries.push(entry);
    };
    messages.forEach((message, relativeIndex) => {
        const index = offset + relativeIndex;
        const next = messages[relativeIndex + 1];
        if (isToolMessage(message) || (message.role === "assistant" && (message.toolCalls?.length || (next && isToolMessage(next))))) {
            add({ message, index });
            return;
        }
        if (message.role === "assistant" && message.thinking) {
            add({ message: { role: message.role, text: "", thinking: message.thinking }, index });
        }
        if (message.role === "assistant" && !message.text.trim())
            return;
        process = undefined;
        rows.push({ kind: "message", key: `message:${index}`, entry: { message: { ...message, thinking: "" }, index } });
    });
    if (process)
        process.active = running;
    return rows;
}
/** The same source strings the renderer makes searchable, in display order. */
export function conversationRowText(row) {
    if (row.kind === "message")
        return row.entry.message.text;
    const results = new Map(row.entries.flatMap(({ message }) => message.toolCallId ? [[message.toolCallId, message]] : []));
    const calls = new Set(row.entries.flatMap(({ message }) => message.toolCalls?.map((call) => call.id) ?? []));
    return row.entries.flatMap(({ message }) => {
        if (isToolMessage(message) && message.toolCallId && calls.has(message.toolCallId))
            return [];
        return [message.thinking ?? "", message.text, ...(message.toolCalls?.flatMap((call) => [call.name, call.input, results.get(call.id)?.text ?? ""]) ?? [])];
    }).filter(Boolean).join("\n");
}
/** Prefer the action's target over generic byte counts; preserve full input below. */
export function toolCallSummary(call) {
    let input;
    try {
        input = JSON.parse(call.input);
    }
    catch {
        return compact(call.input);
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
        return compact(call.input);
    const values = input;
    const fields = ["command", "path", "file_path", "query", "url", "title", "serverId", "toolName", "action", "pattern", "objective", "agentId", "sessionId", "id"];
    const parts = fields.flatMap((field) => typeof values[field] === "string" && values[field] ? [String(values[field])] : []);
    return compact(parts.length ? parts.slice(0, 2).join(" · ") : call.input === "{}" ? t("无参数") : call.input);
}
function compact(value) {
    const line = value.replace(/\s+/g, " ").trim();
    return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
//# sourceMappingURL=conversation.js.map