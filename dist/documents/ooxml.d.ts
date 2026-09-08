import { ZipArchive } from "./zip.js";
/**
 * Text out of Office Open XML packages: `.docx`, `.xlsx` and `.pptx`, plus
 * anything WPS wrote in the same containers under a different extension.
 *
 * These are read with a scanner rather than a DOM: only character data and a
 * handful of break elements matter, the parts are machine-generated, and a
 * general XML parser would be a dependency handling untrusted documents.
 */
export type OoxmlKind = "docx" | "xlsx" | "pptx";
export interface OoxmlDocument {
    kind: OoxmlKind;
    text: string;
    /** One entry per worksheet or slide; empty for a word-processing document. */
    sections: readonly {
        name: string;
        text: string;
    }[];
}
/** Which OOXML format a package holds, decided by the parts it carries. */
export declare function detectOoxmlKind(archive: ZipArchive): OoxmlKind | undefined;
export declare function extractOoxml(archive: ZipArchive, kind: OoxmlKind): OoxmlDocument;
//# sourceMappingURL=ooxml.d.ts.map