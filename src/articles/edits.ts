import { alignArticleDraft } from "./diff.js";

export interface ArticleEdit {
  find: string;
  replace: string;
}

/**
 * What an `update` with edits commits: each `find` is replaced at its first
 * occurrence, in order, so a later edit sees the text the earlier ones left.
 */
export function applyArticleEdits(content: string, edits: readonly ArticleEdit[]): string {
  let next = content;
  for (const edit of edits) {
    if (!edit.find) throw new Error("Article edit is missing the text to find");
    const index = next.indexOf(edit.find);
    if (index < 0) throw new Error("Article edit could not find the text to replace. Read the article and quote it exactly.");
    next = `${next.slice(0, index)}${edit.replace}${next.slice(index + edit.find.length)}`;
  }
  return next;
}

/**
 * The document as it will read once the edits written so far land, for a panel
 * that shows the revision while the model is still typing it.
 *
 * Same rules as a commit, except that an edit whose text cannot be found is
 * skipped rather than fatal — the commit will report it — and the last edit's
 * replacement may still be arriving (`open`). A replacement that has not yet
 * departed from the text it replaces leaves that text alone, so a paragraph the
 * model is extending does not vanish and get typed back in.
 */
export function previewArticleEdits(
  content: string,
  edits: readonly ArticleEdit[],
  open: boolean,
): { text: string; applied: number } {
  let next = content;
  let applied = 0;
  edits.forEach((edit, position) => {
    if (!edit.find) return;
    const index = next.indexOf(edit.find);
    if (index < 0) return;
    const replacement = open && position === edits.length - 1 ? replacementSoFar(edit.find, edit.replace) : edit.replace;
    next = `${next.slice(0, index)}${replacement}${next.slice(index + edit.find.length)}`;
    applied += 1;
  });
  return { text: next, applied };
}

/**
 * A replacement cut off mid-stream, shown the way a streaming rewrite of the
 * whole document is: what has been written, then the old blocks it has not
 * reached yet.
 */
function replacementSoFar(find: string, written: string): string {
  if (find.startsWith(written)) return find;
  const { pending } = alignArticleDraft(find, written);
  return pending.length === 0 ? written : `${written}\n\n${pending.join("\n\n")}`;
}
