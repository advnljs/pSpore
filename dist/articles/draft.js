/**
 * Pulls the article markdown out of a streaming tool-call update.
 *
 * Pi repairs partial JSON as tokens arrive, so `arguments.content` grows while
 * the model is still writing. Anything that is not an `article` call, or that
 * has not produced a content string yet, is ignored.
 */
export function articleDraftFromUpdate(sessionId, update, message) {
    if (update.type !== "toolcall_delta" && update.type !== "toolcall_end")
        return undefined;
    if (update.contentIndex === undefined)
        return undefined;
    const source = isRecord(update.partial) ? update.partial : isRecord(message) ? message : undefined;
    if (!source)
        return undefined;
    const content = source["content"];
    if (!Array.isArray(content))
        return undefined;
    const block = content[update.contentIndex];
    if (!isRecord(block) || block["type"] !== "toolCall" || block["name"] !== "article")
        return undefined;
    if (typeof block["id"] !== "string" || block["id"].length === 0)
        return undefined;
    const args = isRecord(block["arguments"]) ? block["arguments"] : undefined;
    if (!args || typeof args["content"] !== "string" || args["content"].length === 0)
        return undefined;
    const title = typeof args["title"] === "string" && args["title"].trim() ? args["title"].trim() : undefined;
    const articleId = typeof args["id"] === "string" && args["id"].trim() ? args["id"].trim() : undefined;
    return {
        toolCallId: block["id"],
        sessionId,
        content: args["content"],
        ...(title ? { title } : {}),
        ...(articleId ? { articleId } : {}),
    };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=draft.js.map