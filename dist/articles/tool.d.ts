import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ArticleStore } from "./store.js";
import { type ArticleWriterModels } from "./writer.js";
/**
 * The writing surface for a long document.
 *
 * Chat stays a short receipt. The body lives in the article store, one file
 * per version, and the desktop panel renders whichever version is current.
 * `read` is the exception that returns the body: after compaction the model
 * no longer has the text it wrote, and it cannot revise what it cannot see.
 * The desktop broadcast strips that body; the panel loads the file.
 */
export declare function createArticleTools(sessionId: string, articles: ArticleStore, models?: ArticleWriterModels): ToolDefinition[];
//# sourceMappingURL=tool.d.ts.map