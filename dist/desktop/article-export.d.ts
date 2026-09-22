import { BrowserWindow } from "electron";
import { ArticleStore } from "../articles/store.js";
import type { ArticleExportRequest, ArticleExportResult } from "./ipc-contract.js";
/**
 * Turns one saved article version into a file the user picked.
 *
 * txt drops markdown markers. md is the source. docx and pdf keep headings,
 * emphasis, lists, tables and code. pdf is Chromium's print of the HTML, so
 * Chinese uses the desktop's fonts instead of an embedded face.
 */
export declare function exportArticleFile(articles: ArticleStore, request: ArticleExportRequest, owner: BrowserWindow): Promise<ArticleExportResult>;
//# sourceMappingURL=article-export.d.ts.map