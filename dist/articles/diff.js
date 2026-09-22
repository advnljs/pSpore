/**
 * Block diff for article versions.
 *
 * Blocks are blank-line separated, and a fenced code block stays in one piece,
 * so a rewrite of one paragraph does not mark the rest of the document as new.
 * The desktop panel uses the result both for the "+N −M" line and to decide
 * which rendered blocks to animate.
 */
/** Above this, the LCS table is skipped for a prefix/suffix comparison. */
const MAX_LCS_CELLS = 250_000;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
export function splitArticleBlocks(source) {
    const lines = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    const blocks = [];
    let current = [];
    let fence;
    const flush = () => {
        if (current.length === 0)
            return;
        const text = current.join("\n");
        if (text.trim() !== "")
            blocks.push(text);
        current = [];
    };
    for (const line of lines) {
        if (fence) {
            current.push(line);
            if (isClosingFence(line, fence))
                fence = undefined;
            continue;
        }
        const opened = FENCE.exec(line);
        if (opened) {
            flush();
            fence = opened[1];
            current.push(line);
            continue;
        }
        if (line.trim() === "") {
            flush();
            continue;
        }
        current.push(line);
    }
    flush();
    return blocks;
}
export function diffArticleBlocks(before, after) {
    return diffBlockLists(splitArticleBlocks(before), splitArticleBlocks(after));
}
export function articleChangeCounts(diff) {
    let added = 0;
    let removed = 0;
    for (const block of diff) {
        if (block.kind === "add")
            added += 1;
        else if (block.kind === "remove")
            removed += 1;
    }
    return { added, removed };
}
function diffBlockLists(before, after) {
    if (before.length === 0)
        return after.map((source) => ({ kind: "add", source }));
    if (after.length === 0)
        return before.map((source) => ({ kind: "remove", source }));
    if (before.length * after.length > MAX_LCS_CELLS)
        return prefixSuffixDiff(before, after);
    return lcsDiff(before, after);
}
function lcsDiff(before, after) {
    const rows = before.length + 1;
    const columns = after.length + 1;
    const scores = new Array(rows * columns).fill(0);
    const at = (row, column) => scores[row * columns + column] ?? 0;
    for (let row = before.length - 1; row >= 0; row -= 1) {
        for (let column = after.length - 1; column >= 0; column -= 1) {
            const next = before[row] === after[column]
                ? at(row + 1, column + 1) + 1
                : Math.max(at(row + 1, column), at(row, column + 1));
            scores[row * columns + column] = next;
        }
    }
    const diff = [];
    let row = 0;
    let column = 0;
    while (row < before.length && column < after.length) {
        if (before[row] === after[column]) {
            diff.push({ kind: "same", source: after[column] ?? "" });
            row += 1;
            column += 1;
        }
        else if (at(row + 1, column) >= at(row, column + 1)) {
            diff.push({ kind: "remove", source: before[row] ?? "" });
            row += 1;
        }
        else {
            diff.push({ kind: "add", source: after[column] ?? "" });
            column += 1;
        }
    }
    while (row < before.length) {
        diff.push({ kind: "remove", source: before[row] ?? "" });
        row += 1;
    }
    while (column < after.length) {
        diff.push({ kind: "add", source: after[column] ?? "" });
        column += 1;
    }
    return diff;
}
function prefixSuffixDiff(before, after) {
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start])
        start += 1;
    let beforeEnd = before.length;
    let afterEnd = after.length;
    while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
        beforeEnd -= 1;
        afterEnd -= 1;
    }
    const diff = [];
    for (let index = 0; index < start; index += 1)
        diff.push({ kind: "same", source: after[index] ?? "" });
    for (let index = start; index < beforeEnd; index += 1)
        diff.push({ kind: "remove", source: before[index] ?? "" });
    for (let index = start; index < afterEnd; index += 1)
        diff.push({ kind: "add", source: after[index] ?? "" });
    for (let index = afterEnd; index < after.length; index += 1)
        diff.push({ kind: "same", source: after[index] ?? "" });
    return diff;
}
function isClosingFence(line, marker) {
    const trimmed = line.trim();
    const character = marker[0] ?? "`";
    return trimmed.length >= marker.length && [...trimmed].every((entry) => entry === character);
}
/**
 * Below this share of shared tokens, two paired lines are treated as unrelated
 * and shown as a whole-line replacement. Marking a handful of incidental
 * characters inside two different sentences reads as noise, not as a revision.
 */
const MIN_PAIR_SIMILARITY = 0.4;
/** Latin runs and whitespace runs are one token; every other character, CJK included, stands alone. */
const TOKEN = /[A-Za-z0-9_]+|\s+|[\s\S]/gu;
export function splitArticleLines(source) {
    return source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}
export function diffArticleLines(before, after, granularity = "token") {
    const lines = numberLines(diffLineLists(splitArticleLines(before), splitArticleLines(after)));
    return granularity === "token" ? pairLines(lines) : lines;
}
export function articleLineChangeCounts(diff) {
    let added = 0;
    let removed = 0;
    for (const line of diff) {
        if (line.kind === "add")
            added += 1;
        else if (line.kind === "remove")
            removed += 1;
    }
    return { added, removed };
}
function diffLineLists(before, after) {
    // Trimming the shared head and tail first is what keeps a one-paragraph edit
    // inside a long article well under the table budget.
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start])
        start += 1;
    let beforeEnd = before.length;
    let afterEnd = after.length;
    while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
        beforeEnd -= 1;
        afterEnd -= 1;
    }
    const head = before.slice(0, start).map((text) => ({ kind: "same", text }));
    const tail = before.slice(beforeEnd).map((text) => ({ kind: "same", text }));
    const middleBefore = before.slice(start, beforeEnd);
    const middleAfter = after.slice(start, afterEnd);
    const middle = middleBefore.length * middleAfter.length > MAX_LCS_CELLS
        ? [
            ...middleBefore.map((text) => ({ kind: "remove", text })),
            ...middleAfter.map((text) => ({ kind: "add", text })),
        ]
        : lcsLines(middleBefore, middleAfter);
    return [...head, ...middle, ...tail];
}
function lcsLines(before, after) {
    const blocks = lcsDiff(before, after);
    return blocks.map((block) => ({ kind: block.kind, text: block.source }));
}
function numberLines(lines) {
    let beforeNumber = 0;
    let afterNumber = 0;
    return lines.map((line) => {
        if (line.kind === "remove")
            beforeNumber += 1;
        else if (line.kind === "add")
            afterNumber += 1;
        else {
            beforeNumber += 1;
            afterNumber += 1;
        }
        return { kind: line.kind, text: line.text, number: line.kind === "remove" ? beforeNumber : afterNumber };
    });
}
/**
 * Marks the difference inside lines that replaced one another.
 *
 * A run of removals immediately followed by a run of additions is a rewrite;
 * pairing them position by position and diffing the tokens is what turns "this
 * whole line changed" into "these three words changed".
 */
function pairLines(lines) {
    const paired = [...lines];
    let index = 0;
    while (index < paired.length) {
        if (paired[index]?.kind !== "remove") {
            index += 1;
            continue;
        }
        let removeEnd = index;
        while (paired[removeEnd]?.kind === "remove")
            removeEnd += 1;
        let addEnd = removeEnd;
        while (paired[addEnd]?.kind === "add")
            addEnd += 1;
        const pairs = Math.min(removeEnd - index, addEnd - removeEnd);
        for (let offset = 0; offset < pairs; offset += 1) {
            const removed = paired[index + offset];
            const added = paired[removeEnd + offset];
            if (!removed || !added)
                continue;
            const marked = markPair(removed.text, added.text);
            if (!marked)
                continue;
            paired[index + offset] = { ...removed, segments: marked.removed };
            paired[removeEnd + offset] = { ...added, segments: marked.added };
        }
        index = addEnd > index ? addEnd : index + 1;
    }
    return paired;
}
function markPair(before, after) {
    const beforeTokens = before.match(TOKEN) ?? [];
    const afterTokens = after.match(TOKEN) ?? [];
    if (beforeTokens.length === 0 || afterTokens.length === 0)
        return undefined;
    if (beforeTokens.length * afterTokens.length > MAX_LCS_CELLS)
        return undefined;
    const diff = lcsDiff(beforeTokens, afterTokens);
    const shared = diff.reduce((total, entry) => (entry.kind === "same" ? total + entry.source.length : total), 0);
    const similarity = (2 * shared) / (before.length + after.length || 1);
    if (similarity < MIN_PAIR_SIMILARITY)
        return undefined;
    return {
        removed: collapseSegments(diff.filter((entry) => entry.kind !== "add").map(toSegment)),
        added: collapseSegments(diff.filter((entry) => entry.kind !== "remove").map(toSegment)),
    };
}
function toSegment(entry) {
    return { kind: entry.kind, text: entry.source };
}
/** Adjacent tokens of the same kind become one segment, so the DOM has one node per run. */
function collapseSegments(segments) {
    const merged = [];
    for (const segment of segments) {
        const last = merged.at(-1);
        if (last && last.kind === segment.kind)
            merged[merged.length - 1] = { kind: last.kind, text: last.text + segment.text };
        else
            merged.push({ ...segment });
    }
    return merged;
}
/**
 * Lines a partly-written draft up against the version it is replacing.
 *
 * A model rewriting a document sends it from the top, so early in the write the
 * draft is a few characters and the saved version is the whole article. Showing
 * only the draft empties the panel and retypes the document from nothing, which
 * is exactly what a reader watching a revision does not want to see.
 *
 * The blocks after the last one the draft has reached are therefore kept: what
 * is on screen stays the old version until the draft actually gets there, and
 * the part already rewritten says whether it changed. Whether the tail was
 * deleted or simply not reached yet cannot be known until the version lands, and
 * leaving it up is the answer that does not make the document disappear.
 */
export function alignArticleDraft(previous, draft) {
    const before = splitArticleBlocks(previous);
    const after = splitArticleBlocks(draft);
    if (before.length === 0)
        return { written: after.map((source) => ({ source, changed: true })), pending: [] };
    const kept = new Set(before);
    const written = after.map((source) => ({ source, changed: !kept.has(source) }));
    if (after.length === 0)
        return { written, pending: [...before] };
    // How far into the previous version the draft has got. The blocks it has
    // written past the last one both versions share are assumed to stand in for
    // the same number of old blocks — with no shared block to anchor on there is
    // nothing better to go by, and position is what a rewrite actually follows.
    let row = 0;
    let column = 0;
    let rowMatch = -1;
    let columnMatch = -1;
    for (const entry of diffBlockLists(before, after)) {
        if (entry.kind === "same") {
            rowMatch = row;
            columnMatch = column;
            row += 1;
            column += 1;
        }
        else if (entry.kind === "remove") {
            row += 1;
        }
        else {
            column += 1;
        }
    }
    const reach = Math.min(before.length, Math.max(0, rowMatch + 1 + (after.length - 1 - columnMatch)));
    const pending = before.slice(reach);
    // The block being typed right now is the start of the one it replaces, so
    // showing both would print the same heading twice for a second.
    const last = after.at(-1);
    if (last !== undefined && pending[0] !== undefined && pending[0].startsWith(last))
        pending.shift();
    return { written, pending };
}
//# sourceMappingURL=diff.js.map