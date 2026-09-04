export declare const MAX_COMPOSER_FILE_REFERENCES = 32;
export declare const MAX_COMPOSER_MESSAGE_LENGTH = 65536;
export type ComposerFileReferenceKind = "file" | "directory";
export interface ComposerFileReference {
    path: string;
    kind: ComposerFileReferenceKind;
}
export interface MergeComposerFileReferencesResult {
    references: ComposerFileReference[];
    added: number;
    skipped: number;
}
/**
 * Electron returns an absolute path for an operating-system-backed File. Keep
 * only bounded Linux paths so a dropped browser-created File cannot become an
 * ambiguous prompt reference.
 */
export declare function composerFileReference(path: string, kind: ComposerFileReferenceKind): ComposerFileReference | undefined;
export declare function mergeComposerFileReferences(current: readonly ComposerFileReference[], incoming: readonly ComposerFileReference[], maximum?: number): MergeComposerFileReferencesResult;
export declare function composerFileReferenceToken(reference: ComposerFileReference): string;
export declare function composeMessageWithFileReferences(text: string, references: readonly ComposerFileReference[], maximumLength?: number): string;
export declare function composerFileReferenceName(path: string): string;
//# sourceMappingURL=composer-file-references.d.ts.map