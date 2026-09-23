import { ARTICLE_ID_PATTERN } from "./store.js";
/**
 * Pulls the article being written out of a streaming tool-call update.
 *
 * Pi repairs partial JSON as tokens arrive, so the arguments grow while the
 * model is still writing. A call counts as soon as it says it will write —
 * `create` or `update` — so the panel can open before the first word of the
 * body, and an `update` made of edits is followed as the edits arrive. `read`
 * writes nothing and is ignored, as is anything that is not an `article` call.
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
    if (!args || args["action"] === "read")
        return undefined;
    const title = typeof args["title"] === "string" && args["title"].trim() ? args["title"].trim() : undefined;
    // The id streams in like everything else; a prefix of one names no article.
    const articleId = typeof args["id"] === "string" && ARTICLE_ID_PATTERN.test(args["id"].trim()) ? args["id"].trim() : undefined;
    const body = typeof args["content"] === "string" ? args["content"] : undefined;
    const written = Array.isArray(args["edits"]) ? writtenEdits(args["edits"], update.type === "toolcall_end") : undefined;
    const action = args["action"] === "create" || args["action"] === "update"
        ? args["action"]
        : body !== undefined || written !== undefined ? (articleId ? "update" : "create") : undefined;
    if (!action)
        return undefined;
    return {
        toolCallId: block["id"],
        sessionId,
        action,
        ...(title ? { title } : {}),
        ...(articleId ? { articleId } : {}),
        ...(body === undefined ? {} : { content: body }),
        ...(written === undefined ? {} : { edits: written.edits, editOpen: written.open }),
    };
}
/**
 * The edits whose `find` is whole. Key order is parse order, so once `replace`
 * follows `find` the quote is closed; the last edit's replacement may still be
 * arriving until the call ends.
 */
function writtenEdits(entries, ended) {
    const edits = [];
    let open = false;
    entries.forEach((entry, position) => {
        if (!isRecord(entry) || typeof entry["find"] !== "string" || entry["find"].length === 0)
            return;
        if (typeof entry["replace"] !== "string")
            return;
        if (position === entries.length - 1 && !ended) {
            const keys = Object.keys(entry);
            if (keys.indexOf("find") > keys.indexOf("replace"))
                return;
            open = true;
        }
        edits.push({ find: entry["find"], replace: entry["replace"] });
    });
    return { edits, open };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=draft.js.map