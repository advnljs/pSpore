/**
 * What an `article` tool call is allowed to put on the protocol.
 *
 * The arguments and a `read` result carry the whole document. Publishing that
 * would drop it into the activity card and, past 64 KiB, into the truncation
 * path that exists for ordinary messages. The panel reads the file itself.
 * The model still receives the untouched tool result from Pi.
 */
const ARTICLE_HEAD_LINES = 4;
export function publishedArticleValue(toolName, value) {
    if (toolName !== "article" || !isRecord(value))
        return value;
    if (Array.isArray(value["content"]))
        return publishedResult(value);
    return publishedInput(value);
}
function publishedInput(value) {
    const next = { ...value };
    if (typeof next["instruction"] === "string") {
        next["instructionChars"] = next["instruction"].length;
        delete next["instruction"];
    }
    if (typeof next["content"] === "string") {
        next["contentChars"] = next["content"].length;
        delete next["content"];
    }
    if (Array.isArray(next["edits"])) {
        next["editCount"] = next["edits"].length;
        delete next["edits"];
    }
    return next;
}
function publishedResult(value) {
    const content = value["content"];
    if (!Array.isArray(content))
        return value;
    const details = isRecord(value["details"]) ? { ...value["details"] } : undefined;
    if (details)
        delete details["articleDraft"];
    return {
        ...value,
        ...(details ? { details } : {}),
        content: content.map((block) => {
            if (!isRecord(block) || typeof block["text"] !== "string")
                return block;
            const head = block["text"].split("\n").slice(0, ARTICLE_HEAD_LINES).join("\n");
            return head === block["text"] ? block : { ...block, text: head };
        }),
    };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=publish.js.map