import { OleDocument } from "./ole.js";
/**
 * Text out of the pre-2007 binary Office formats.
 *
 * Each of the three keeps its text somewhere different inside the compound
 * document, and none of them stores it as a contiguous run, so the shape of
 * every function here follows the format rather than a shared abstraction.
 * The goal throughout is the words on the page: layout, styling and revision
 * history are deliberately dropped.
 */
export type LegacyKind = "doc" | "xls" | "ppt";
export interface LegacyDocument {
    kind: LegacyKind;
    text: string;
    sections: readonly {
        name: string;
        text: string;
    }[];
}
/** Which legacy format a compound document holds, decided by its streams. */
export declare function detectLegacyKind(document: OleDocument): LegacyKind | undefined;
export declare function extractLegacy(document: OleDocument, kind: LegacyKind): LegacyDocument;
//# sourceMappingURL=legacy-office.d.ts.map