import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SearchService } from "../memory/search-service.js";
import { ShellService } from "../shell/shell-service.js";
export interface CoreToolOptions {
    workspaceRoot: string;
    shell: ShellService;
    defaultShellTimeoutMs: number;
    maxShellOutputBytes: number;
    maxReadBytes?: number;
    /** Largest document `document` will open; defaults to `DEFAULT_MAX_DOCUMENT_BYTES`. */
    maxDocumentBytes?: number;
    maxSearchOutputBytes?: number;
    retrieval?: Pick<SearchService, "search">;
    defaultSearchMaxResults?: number;
    defaultSearchMaxReturnedTokens?: number;
}
export declare function createCoreTools(options: CoreToolOptions): readonly ToolDefinition[];
//# sourceMappingURL=core-tools.d.ts.map