/** First line of every `article` tool result. The panel and the chat card both key off it. */
export const ARTICLE_RECEIPT = /^article (art_[a-f0-9]{12}) version (\d+)$/;
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