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
//# sourceMappingURL=diff.js.map