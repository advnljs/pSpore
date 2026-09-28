import { type ArticleEdit } from "./edits.js";
export type { ArticleEdit } from "./edits.js";
/** `art_` plus 12 hex characters. Short enough to say, long enough not to guess. */
export declare const ARTICLE_ID_PATTERN: RegExp;
/** A long article, not a book. Past this the tool asks for a tighter draft. */
export declare const MAX_ARTICLE_CHARS = 400000;
/** Versions kept for one article. Each one is a full snapshot so any of them can be reopened. */
export declare const MAX_ARTICLE_VERSIONS = 100;
export interface ArticleVersionInfo {
    version: number;
    createdAt: string;
    chars: number;
    sha256: string;
}
export interface ArticleSummary {
    id: string;
    title: string;
    sessionId: string;
    version: number;
    chars: number;
    updatedAt: string;
}
export interface ArticleCommit {
    id: string;
    title: string;
    version: number;
    chars: number;
    added: number;
    removed: number;
    /** Unchanged content reuses the current version instead of appending an empty one. */
    unchanged: boolean;
    path: string;
}
export interface ArticleDocument {
    id: string;
    title: string;
    sessionId: string;
    version: number;
    versions: readonly ArticleVersionInfo[];
    offset: number;
    length: number;
    text: string;
}
export declare class ArticleStore {
    #private;
    constructor(root: string, clock?: () => Date, idFactory?: () => string);
    get root(): string;
    ready(): Promise<void>;
    create(input: {
        sessionId: string;
        title: string;
        content: string;
    }): Promise<ArticleCommit>;
    update(input: {
        sessionId: string;
        id: string;
        title?: string;
        content?: string;
        edits?: readonly ArticleEdit[];
    }): Promise<ArticleCommit>;
    read(input: {
        sessionId: string;
        id: string;
        version?: number;
        offset?: number;
        limit: number;
    }): Promise<ArticleDocument | undefined>;
    /** Absolute path of one immutable version file, after it has been checked to stay inside the store. */
    versionPath(id: string, version: number): Promise<string>;
    readVersion(id: string, version?: number): Promise<{
        title: string;
        version: number;
        content: string;
    } | undefined>;
    list(sessionId: string): Promise<ArticleSummary[]>;
}
export declare function cleanTitle(title: string): string;
//# sourceMappingURL=store.d.ts.map