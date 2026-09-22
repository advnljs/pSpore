/** First line of every `article` tool result. The panel and the chat card both key off it. */
export declare const ARTICLE_RECEIPT: RegExp;
export interface ArticleReceipt {
    id: string;
    version: number;
    title?: string;
}
export declare function parseArticleReceipt(text: string): ArticleReceipt | undefined;
//# sourceMappingURL=receipt.d.ts.map