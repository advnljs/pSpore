import type { EventEnvelope } from "../../protocol/schema.js";
import type { ArticleExportFormat, ArticleExportResult, DesktopCommand } from "../ipc-contract.js";
/**
 * The document panel. Chat keeps a one-line receipt; this is where the article
 * is rendered, revised, and exported.
 *
 * While the model is still streaming the tool arguments the panel renders that
 * draft. When the tool commits a version, the new blocks pulse against the
 * previous saved text. "对照上一版" leaves the removed blocks on screen.
 */
export declare class ArticlePanel {
    #private;
    constructor(options: {
        sessionId: () => string;
        dispatch: (command: DesktopCommand) => Promise<unknown>;
        exportArticle: (request: {
            id: string;
            version: number;
            format: ArticleExportFormat;
        }) => Promise<ArticleExportResult>;
        onLayout: () => void;
    });
    isOpen(): boolean;
    isWriting(): boolean;
    writingKey(): string;
    /**
     * Called whenever the selected session may have changed, including on the
     * frames that follow a reconnect. The session is often selected for the user
     * — restored at startup, or picked once the daemon answers — so waiting for a
     * click would leave the panel unaware of the articles that session owns. A
     * lookup that could not run, because the daemon was not connected yet, is
     * retried on the next frame instead of leaving the panel silent for good.
     */
    onSessionChanged(): void;
    onEvent(event: EventEnvelope): void;
    open(id: string, version?: number): Promise<void>;
    close(): void;
    /**
     * Follows the space the split divides: a resized window, or the session rail
     * opening or closing. The reader's share is kept, so both halves scale; an open
     * still animating lands on the new width at once rather than on the stale one.
     */
    relayout(): void;
}
//# sourceMappingURL=article-panel.d.ts.map