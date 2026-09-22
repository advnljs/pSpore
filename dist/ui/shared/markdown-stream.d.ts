/**
 * What a streaming markdown message can keep between two renders.
 *
 * A reply is re-parsed from scratch on every token, and rebuilding the whole
 * body each time throws away the DOM the reader may be selecting inside. Almost
 * every token only extends the last block, so this reduces "what changed" to a
 * block count: everything before it is identical markup and can stay on screen.
 *
 * No DOM here, so both the comparison and its reasoning are testable.
 */
import { type MarkdownBlock } from "./markdown.js";
/**
 * A stable identity for each block, in document order.
 *
 * Two blocks with the same key render to the same markup. The key comes from
 * the parsed block rather than the raw text, so a change that does not survive
 * parsing — trailing spaces, a half-typed emphasis marker still being read as
 * literal text — does not needlessly invalidate a block.
 */
export declare function blockKeysOf(blocks: readonly MarkdownBlock[]): string[];
/** Parses `source` and returns its block keys. For callers that do not need the blocks. */
export declare function markdownBlockKeys(source: string): string[];
/** How many leading blocks two renders share, and therefore how many can be left alone. */
export declare function commonBlockPrefix(previous: readonly string[], next: readonly string[]): number;
//# sourceMappingURL=markdown-stream.d.ts.map