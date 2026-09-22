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
    onSessionChanged(): void;
    onEvent(event: EventEnvelope): void;
    open(id: string, version?: number): Promise<void>;
    close(): void;
}
//# sourceMappingURL=article-panel.d.ts.map