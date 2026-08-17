export type SearchScope = "memory" | "sessions" | "workspace" | "project";
export type SearchMode = "auto" | "exact" | "bm25";
export interface SearchQuery {
    query: string;
    scopes?: readonly SearchScope[];
    mode?: SearchMode;
    pathPrefix?: string;
    glob?: string;
    maxResults: number;
    maxReturnedTokens: number;
}
export interface SearchHit {
    ref: string;
    scope: SearchScope;
    path: string;
    line: number;
    heading?: string;
    score: number;
    mtimeMs: number;
    snippet: string;
    contentSha256: string;
}
export interface SearchServiceOptions {
    workspaceRoot: string;
    sessionsRoot: string;
    cachePath: string;
    projectRoot?: string;
    maxFileBytes?: number;
    chunkTargetTokens?: number;
    chunkOverlapTokens?: number;
}
export declare class SearchService {
    #private;
    constructor(options: SearchServiceOptions);
    search(query: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]>;
    ensureIndexed(signal?: AbortSignal): Promise<void>;
}
//# sourceMappingURL=search-service.d.ts.map