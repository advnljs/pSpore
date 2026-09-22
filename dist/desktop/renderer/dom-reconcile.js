/// <reference lib="DOM" />
/**
 * Replaces a container's children with `next` by moving only what is out of place.
 *
 * `replaceChildren` detaches every child even when the same nodes go straight
 * back, and a detached node takes the reader's selection — and any running
 * animation — with it. Both the transcript and the article panel re-render on
 * every frame of a reply, so rebuilding the list is the difference between
 * "you can copy what is on screen" and "you cannot".
 *
 * Dropped children go first. Inserting around one that is on its way out would
 * move every node after it, which costs just as much as rebuilding: removing a
 * single message from the top used to detach every message below it.
 */
export function reconcileChildren(parent, next) {
    const wanted = new Set(next);
    let cursor = parent.firstChild;
    while (cursor) {
        const following = cursor.nextSibling;
        if (!wanted.has(cursor))
            parent.removeChild(cursor);
        cursor = following;
    }
    cursor = parent.firstChild;
    for (const node of next) {
        if (cursor === node) {
            cursor = cursor.nextSibling;
            continue;
        }
        parent.insertBefore(node, cursor);
    }
}
//# sourceMappingURL=dom-reconcile.js.map