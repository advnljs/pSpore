import { findTextHits } from "./session-find.js";
const FIND_ROOT = ".message-body, .thinking-stream-body, details pre, .article-receipt";
/**
 * Find bar for the open session. Matches come from the transcript texts, not
 * the virtualized DOM, so a hit that is scrolled out of view can still be jumped to.
 */
export function createSessionSearch(options) {
    let hits = [];
    let capped = false;
    let active = 0;
    let signature = "";
    let pendingReset = false;
    let pendingScroll = false;
    let focusMark = false;
    let painted = false;
    const isOpen = () => !options.bar.hidden;
    const sync = () => {
        const query = options.input.value;
        const texts = options.getTexts();
        let total = 0;
        for (const text of texts)
            total += text.length;
        const nextSignature = `${options.getSessionId()}\u0000${query}\u0000${texts.length}\u0000${total}`;
        if (nextSignature !== signature) {
            const previous = hits[active];
            const found = findTextHits(texts, query);
            hits = found.hits;
            capped = found.capped;
            signature = nextSignature;
            if (!pendingReset && previous) {
                const kept = hits.findIndex((hit) => hit.index === previous.index && hit.occurrence === previous.occurrence);
                if (kept >= 0)
                    active = kept;
                else if (active >= hits.length)
                    active = Math.max(0, hits.length - 1);
            }
        }
        if (pendingReset) {
            active = 0;
            pendingReset = false;
        }
        if (active >= hits.length)
            active = 0;
    };
    const updateCount = () => {
        const query = options.input.value.trim();
        const empty = !query || hits.length === 0;
        options.previous.disabled = empty;
        options.next.disabled = empty;
        if (!query) {
            options.count.textContent = "";
            return;
        }
        if (hits.length === 0) {
            options.count.textContent = "无匹配";
            return;
        }
        options.count.textContent = `${active + 1} / ${hits.length}${capped ? "+" : ""}`;
    };
    const step = (delta) => {
        sync();
        if (hits.length === 0) {
            updateCount();
            return;
        }
        active = (active + delta + hits.length) % hits.length;
        pendingScroll = true;
        focusMark = true;
        options.requestRender();
    };
    const open = () => {
        const already = isOpen();
        options.bar.hidden = false;
        options.button.setAttribute("aria-expanded", "true");
        options.input.focus();
        options.input.select();
        if (!already && options.input.value.trim()) {
            pendingScroll = true;
            focusMark = true;
        }
        options.requestRender();
    };
    const close = () => {
        if (!isOpen() && !painted)
            return;
        options.bar.hidden = true;
        options.button.setAttribute("aria-expanded", "false");
        pendingScroll = false;
        focusMark = false;
        options.setPinnedIndex(undefined);
        clearEveryMessage();
        painted = false;
        const focus = document.activeElement;
        if (focus instanceof Node && options.bar.contains(focus))
            options.transcript.focus();
        options.requestRender();
    };
    const clearEveryMessage = () => {
        options.forEachMessage((node) => {
            clearFindMarks(node);
            delete node.dataset["findStamp"];
        });
    };
    options.button.addEventListener("click", () => {
        if (isOpen())
            close();
        else
            open();
    });
    options.close.addEventListener("click", () => close());
    options.previous.addEventListener("click", () => step(-1));
    options.next.addEventListener("click", () => step(1));
    options.input.addEventListener("input", () => {
        pendingReset = true;
        pendingScroll = options.input.value.trim().length > 0;
        focusMark = pendingScroll;
        signature = "";
        options.requestRender();
    });
    options.input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.isComposing)
            return;
        event.preventDefault();
        step(event.shiftKey ? -1 : 1);
    });
    window.addEventListener("keydown", (event) => {
        if (event.isComposing)
            return;
        const key = event.key.toLowerCase();
        const command = event.ctrlKey || event.metaKey;
        if (command && key === "f" && !event.altKey && !event.shiftKey) {
            if (options.isModalOpen() || document.querySelector(".local-link-menu"))
                return;
            event.preventDefault();
            open();
            return;
        }
        if (!isOpen() || document.querySelector(".local-link-menu"))
            return;
        if (event.key === "Escape") {
            event.preventDefault();
            close();
            return;
        }
        if (event.key === "F3" || (command && key === "g" && !event.altKey)) {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
        }
    }, true);
    return {
        prepare(sessionChanged) {
            if (!isOpen())
                return;
            if (sessionChanged && options.input.value.trim()) {
                pendingReset = true;
                pendingScroll = true;
                focusMark = true;
                signature = "";
            }
            sync();
            if (!pendingScroll)
                return;
            pendingScroll = false;
            const hit = hits[active];
            if (!hit)
                return;
            options.setFollowTail(false);
            options.setPinnedIndex(hit.index);
            const viewport = Math.max(1, options.transcript.clientHeight);
            const top = Math.max(0, options.getOffset(hit.index) - Math.round(viewport * 0.28));
            if (Math.abs(options.transcript.scrollTop - top) > 1)
                options.transcript.scrollTop = top;
        },
        paint() {
            if (!isOpen()) {
                if (painted) {
                    clearEveryMessage();
                    painted = false;
                    options.setPinnedIndex(undefined);
                }
                return;
            }
            sync();
            updateCount();
            const query = options.input.value.trim();
            const hit = query ? hits[active] : undefined;
            if (!query) {
                clearEveryMessage();
                painted = false;
                options.setPinnedIndex(undefined);
                return;
            }
            options.setPinnedIndex(hit?.index);
            const visible = Array.from(options.transcript.querySelectorAll("[data-virtual-index]"));
            const foldedQuery = query.toLowerCase();
            for (const node of visible) {
                const index = Number(node.dataset["virtualIndex"]);
                const occurrence = hit?.index === index ? hit.occurrence : undefined;
                const stamp = `${query}\u0000${occurrence ?? ""}\u0000${node.textContent?.length ?? 0}`;
                const containsQuery = (node.textContent ?? "").toLowerCase().includes(foldedQuery);
                const marks = node.querySelectorAll("mark.session-find-hit");
                const currentOk = occurrence === undefined || node.querySelector("mark.session-find-hit.current");
                // A streaming rewrite drops the marks without changing this stamp's inputs.
                if (node.dataset["findStamp"] === stamp && (!containsQuery || (marks.length > 0 && currentOk)))
                    continue;
                highlightQuery(node, query, occurrence);
                node.dataset["findStamp"] = stamp;
            }
            painted = true;
            if (!focusMark)
                return;
            focusMark = false;
            requestAnimationFrame(() => {
                const mark = options.transcript.querySelector("mark.session-find-hit.current");
                if (!(mark instanceof HTMLElement))
                    return;
                const details = mark.closest("details");
                if (details instanceof HTMLDetailsElement && !details.open)
                    details.open = true;
                const box = options.transcript.getBoundingClientRect();
                const rect = mark.getBoundingClientRect();
                if (rect.top < box.top + 12 || rect.bottom > box.bottom - 12) {
                    mark.scrollIntoView({ block: "center", inline: "nearest" });
                }
            });
        },
    };
}
function highlightQuery(message, query, activeOccurrence) {
    const roots = message.querySelectorAll(FIND_ROOT);
    roots.forEach((root) => clearFindMarks(root));
    const needle = query.toLowerCase();
    if (!needle)
        return;
    let seen = 0;
    let current;
    let last;
    for (const root of Array.from(roots)) {
        const nodes = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let next = walker.nextNode();
        while (next) {
            const text = next;
            if ((text.nodeValue ?? "").toLowerCase().includes(needle))
                nodes.push(text);
            next = walker.nextNode();
        }
        for (const node of nodes) {
            const value = node.nodeValue ?? "";
            const folded = value.toLowerCase();
            const fragment = document.createDocumentFragment();
            let cursor = 0;
            let from = 0;
            while (from < folded.length) {
                const at = folded.indexOf(needle, from);
                if (at < 0)
                    break;
                if (at > cursor)
                    fragment.append(document.createTextNode(value.slice(cursor, at)));
                const mark = document.createElement("mark");
                const end = at + needle.length;
                mark.className = "session-find-hit";
                mark.textContent = value.slice(at, end);
                if (seen === activeOccurrence) {
                    mark.classList.add("current");
                    current = mark;
                }
                last = mark;
                fragment.append(mark);
                seen += 1;
                cursor = end;
                from = end;
            }
            if (cursor < value.length)
                fragment.append(document.createTextNode(value.slice(cursor)));
            if (cursor > 0)
                node.replaceWith(fragment);
        }
    }
    if (activeOccurrence !== undefined && !current && last)
        last.classList.add("current");
}
function clearFindMarks(root) {
    const marks = Array.from(root.querySelectorAll("mark.session-find-hit"));
    for (const mark of marks) {
        const parent = mark.parentNode;
        if (!parent)
            continue;
        parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
        parent.normalize();
    }
}
//# sourceMappingURL=session-search.js.map