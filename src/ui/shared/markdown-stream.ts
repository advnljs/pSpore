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

import { parseMarkdown, type MarkdownBlock } from "./markdown.js";

/**
 * A stable identity for each block, in document order.
 *
 * Two blocks with the same key render to the same markup. The key comes from
 * the parsed block rather than the raw text, so a change that does not survive
 * parsing — trailing spaces, a half-typed emphasis marker still being read as
 * literal text — does not needlessly invalidate a block.
 */
export function blockKeysOf(blocks: readonly MarkdownBlock[]): string[] {
  return blocks.map((block) => JSON.stringify(block));
}

/** Parses `source` and returns its block keys. For callers that do not need the blocks. */
export function markdownBlockKeys(source: string): string[] {
  return blockKeysOf(parseMarkdown(source));
}

/** How many leading blocks two renders share, and therefore how many can be left alone. */
export function commonBlockPrefix(previous: readonly string[], next: readonly string[]): number {
  const limit = Math.min(previous.length, next.length);
  let shared = 0;
  while (shared < limit && previous[shared] === next[shared]) shared += 1;
  return shared;
}
