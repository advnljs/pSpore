/** First line of every `article` tool result. The panel and the chat card both key off it. */
export const ARTICLE_RECEIPT = /^article (art_[a-f0-9]{12}) version (\d+)$/;
/** A preparation call opens the surface without pretending a version was saved. */
export function parseArticleOpenReceipt(text) {
    const [head, titleLine] = text.split("\n");
    const match = /^article open(?: (art_[a-f0-9]{12}) version ([1-9]\d*))?$/.exec(head?.trim() ?? "");
    const title = titleLine?.startsWith("标题：") ? titleLine.slice("标题：".length).trim() : undefined;
    if (!match || !title)
        return undefined;
    return { title, ...(match[1] ? { id: match[1], version: Number(match[2]) } : {}) };
}
export function parseArticleReceipt(text) {
    const [head, titleLine] = text.split("\n");
    const match = ARTICLE_RECEIPT.exec(head?.trim() ?? "");
    if (!match)
        return undefined;
    const version = Number(match[2]);
    if (!Number.isInteger(version) || version < 1)
        return undefined;
    const title = titleLine?.startsWith("标题：") ? titleLine.slice("标题：".length).trim() : undefined;
    return {
        id: match[1] ?? "",
        version,
        ...(title ? { title } : {}),
    };
}
//# sourceMappingURL=receipt.js.map