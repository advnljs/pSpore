/// <reference lib="DOM" />
import { articleChangeCounts, articleLineChangeCounts, diffArticleBlocks, diffArticleLines, splitArticleBlocks, } from "../../articles/diff.js";
import { parseArticleReceipt } from "../../articles/receipt.js";
import { readFullMessage } from "../../ui/shared/full-message.js";
import { reconcileChildren } from "./dom-reconcile.js";
import { appendMarkdown } from "./markdown-view.js";
import { collapseArticleRemovals, pulseArticleChanges, slideArticlePanel } from "./motion.js";
/** New blocks that pulse in at once. Past this the page flashes rather than draws attention. */
const MAX_PULSED_BLOCKS = 16;
/**
 * Looking up the session's articles can start before the daemon answers. Frames
 * stop arriving once the session is idle, so a failed lookup has to come back on
 * its own rather than wait for one that may never come.
 */
const REOPEN_RETRY_MS = 300;
const REOPEN_RETRY_LIMIT = 8;
/** Blocks kept for reuse, on screen or not. Bounded so a long revision history cannot grow it forever. */
const BLOCK_POOL_SIZE = 512;
/**
 * Makes a signature unique among identical siblings.
 *
 * Two identical paragraphs render the same markup, so the key has to say which
 * of them this is; otherwise the second one reuses the first one's node and the
 * list collapses.
 */
function keyOf(seen, signature) {
    const occurrence = (seen.get(signature) ?? 0) + 1;
    seen.set(signature, occurrence);
    return `${occurrence}\u0000${signature}`;
}
/** Rendered markdown blocks, keyed by what they draw so an unchanged one keeps its element. */
function blockEntries(sources) {
    const seen = new Map();
    return sources.map((source) => ({
        key: keyOf(seen, `block\u0000${source}`),
        build: () => {
            const wrap = document.createElement("div");
            wrap.className = "article-block";
            appendMarkdown(wrap, source);
            return wrap;
        },
    }));
}
/** One line of a revision: a gutter mark and the text, with the rewrite marked inside it. */
function diffLineNode(line) {
    const row = document.createElement("div");
    row.className = "article-diff-line";
    row.dataset["change"] = line.kind;
    const gutter = document.createElement("span");
    gutter.className = "article-diff-gutter";
    gutter.setAttribute("aria-hidden", "true");
    gutter.textContent = String(line.number);
    const mark = document.createElement("span");
    mark.className = "article-diff-mark";
    mark.textContent = line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ";
    const text = document.createElement("span");
    text.className = "article-diff-text";
    const segments = line.segments;
    if (segments && segments.length > 0) {
        for (const segment of segments) {
            if (segment.kind === "same") {
                text.append(document.createTextNode(segment.text));
                continue;
            }
            const marked = document.createElement(segment.kind === "add" ? "ins" : "del");
            marked.textContent = segment.text;
            text.append(marked);
        }
    }
    else {
        text.textContent = line.text;
    }
    row.append(gutter, mark, text);
    return row;
}
/**
 * The document panel. Chat keeps a one-line receipt; this is where the article
 * is rendered, revised, and exported.
 *
 * While the model is still streaming the tool arguments the panel renders that
 * draft. When the tool commits a version, the new blocks pulse against the
 * previous saved text. "对照上一版" leaves the removed blocks on screen.
 */
export class ArticlePanel {
    #sessionId;
    #dispatch;
    #exportArticle;
    #onLayout;
    #panel;
    #title;
    #version;
    #versions;
    #summary;
    #stage;
    #render;
    #status;
    #viewButtons;
    #reopen;
    #exportButtons;
    #open = false;
    #view = "read";
    /**
     * Blocks keyed by what they render, including ones not on screen right now.
     *
     * A draft passes through partial forms of almost every block on its way to the
     * finished version. Dropping an element the moment it stops matching would
     * mean rebuilding it a second later when the block is whole again, so recently
     * detached blocks stay here until the pool is full.
     */
    #nodes = new Map();
    #paintSequence = 0;
    /** The view the reader chose, restored once a draft becomes a version again. */
    #preferredView = "read";
    #writing = false;
    #writingKey = "";
    #token = 0;
    #session = "";
    #articleId = "";
    #loadedVersion = 0;
    #titleText = "";
    /** Text of the version this one replaced, when we watched that hand-off. */
    #baseline = "";
    #committed = "";
    #versionsKnown = [];
    #reopenId = "";
    #reopenTitle = "";
    /** Session whose article list has been read. "" means the lookup still owes us an answer. */
    #reopenSession = "";
    #reopenInFlight = false;
    #reopenRetries = 0;
    #exporting = false;
    constructor(options) {
        this.#sessionId = options.sessionId;
        this.#dispatch = options.dispatch;
        this.#exportArticle = options.exportArticle;
        this.#onLayout = options.onLayout;
        this.#panel = requiredElement("article-panel");
        this.#title = requiredElement("article-title");
        this.#version = requiredElement("article-version");
        this.#versions = requiredElement("article-versions");
        this.#summary = requiredElement("article-diff-summary");
        this.#stage = requiredElement("article-stage");
        this.#render = requiredElement("article-render");
        this.#status = requiredElement("article-status");
        this.#viewButtons = Array.from(requiredElement("article-views").querySelectorAll("[data-view]"));
        this.#reopen = requiredButton("open-article-button");
        this.#syncViews(false);
        requiredButton("article-close").addEventListener("click", () => this.close());
        for (const button of this.#viewButtons) {
            button.addEventListener("click", () => {
                const view = button.dataset["view"];
                if (view !== "read" && view !== "token" && view !== "line")
                    return;
                if (view === this.#view)
                    return;
                this.#view = view;
                this.#preferredView = view;
                this.#syncViews(this.#baseline !== "");
                this.#syncSummary(this.#baseline, this.#loadedVersion);
                if (this.#articleId)
                    this.#paint(this.#baseline, false, "top");
            });
        }
        this.#reopen.addEventListener("click", () => {
            if (this.#reopenId)
                void this.open(this.#reopenId);
        });
        this.#exportButtons = Array.from(this.#panel.querySelectorAll("[data-export]"));
        for (const button of this.#exportButtons) {
            button.addEventListener("click", () => {
                const format = button.dataset["export"];
                if (format === "txt" || format === "md" || format === "docx" || format === "pdf")
                    void this.#export(format);
            });
        }
    }
    isOpen() {
        return this.#open;
    }
    isWriting() {
        return this.#writing;
    }
    writingKey() {
        return this.#writingKey;
    }
    /**
     * Called whenever the selected session may have changed, including on the
     * frames that follow a reconnect. The session is often selected for the user
     * — restored at startup, or picked once the daemon answers — so waiting for a
     * click would leave the panel unaware of the articles that session owns. A
     * lookup that could not run, because the daemon was not connected yet, is
     * retried on the next frame instead of leaving the panel silent for good.
     */
    onSessionChanged() {
        const sessionId = this.#sessionId();
        if (sessionId !== this.#session) {
            this.#session = sessionId;
            this.#token += 1;
            this.#writing = false;
            this.#reopenSession = "";
            this.#reopenRetries = 0;
            this.close();
        }
        if (!sessionId || this.#reopenSession === sessionId || this.#reopenInFlight)
            return;
        void this.#refreshReopen(sessionId);
    }
    onEvent(event) {
        const payload = asRecord(event.payload);
        if (stringValue(payload["sessionId"]) !== this.#sessionId())
            return;
        if (event.type === "article.preview") {
            const toolCallId = stringValue(payload["toolCallId"]);
            if (!toolCallId)
                return;
            void this.#onPreview(toolCallId, stringValue(payload["title"]), stringValue(payload["articleId"]));
            return;
        }
        if (event.type !== "tool.completed" || stringValue(payload["toolName"]) !== "article" || payload["isError"] === true) {
            if (event.type === "tool.completed" && stringValue(payload["toolName"]) === "article" && payload["isError"] === true) {
                this.#writing = false;
                this.#status.textContent = "这一版没有写入";
            }
            return;
        }
        const receipt = parseArticleReceipt(toolResultText(payload["result"]));
        if (!receipt)
            return;
        void this.#onCommitted(receipt.id, receipt.version, receipt.title);
    }
    async open(id, version) {
        const token = ++this.#token;
        this.#show(this.#titleText || "文稿");
        this.#status.textContent = "正在载入文稿…";
        const loaded = await this.#load(id, version);
        if (token !== this.#token || !loaded) {
            if (token === this.#token)
                this.#status.textContent = "没有找到文稿";
            return;
        }
        // Opening a document, or stepping to another version, is a request to read
        // it — so it starts at the title, not at whatever the last line happens to be.
        this.#applyLoaded(loaded, true, "top");
    }
    close() {
        if (!this.#open && this.#panel.hidden) {
            this.#syncReopen();
            return;
        }
        this.#open = false;
        this.#writing = false;
        this.#panel.hidden = true;
        delete document.documentElement.dataset["article"];
        this.#onLayout();
        this.#syncReopen();
    }
    async #onPreview(toolCallId, title, articleId) {
        const token = ++this.#token;
        this.#writing = true;
        // A draft has no saved version behind it, so there is nothing to compare it
        // against until it lands. The reader's choice comes back with the version.
        this.#view = "read";
        this.#syncViews(false);
        this.#writingKey = toolCallId;
        this.#show(title || this.#titleText || "正在撰写");
        this.#status.textContent = "正在撰写…";
        const text = await this.#readSlices((offset, limit) => this.#dispatch({
            action: "article.preview",
            sessionId: this.#sessionId(),
            toolCallId,
            offset,
            limit,
        }));
        if (token !== this.#token || text === undefined)
            return;
        if (articleId)
            this.#articleId = articleId;
        if (title)
            this.#titleText = title;
        this.#title.textContent = this.#titleText || "正在撰写";
        this.#renderLive(text);
        this.#status.textContent = `${text.length} 字 · 撰写中`;
    }
    async #onCommitted(id, version, title) {
        const token = ++this.#token;
        this.#writing = false;
        this.#show(title || this.#titleText || "文稿");
        // Streaming only kept the draft, so an update that lands without the prior
        // version on screen still diffs against that saved text.
        if (!(this.#articleId === id && this.#loadedVersion === version - 1) && version > 1) {
            const previous = await this.#load(id, version - 1);
            if (token !== this.#token)
                return;
            if (previous) {
                this.#articleId = previous.id;
                this.#loadedVersion = previous.version;
                this.#committed = previous.text;
            }
        }
        const loaded = await this.#load(id, version);
        if (token !== this.#token || !loaded)
            return;
        this.#applyLoaded(loaded, true, "keep");
    }
    #applyLoaded(loaded, animate, anchor) {
        const sequential = this.#articleId === loaded.id && this.#loadedVersion > 0 && loaded.version === this.#loadedVersion + 1;
        const firstVersion = this.#loadedVersion === 0 && loaded.version === 1;
        const baseline = sequential ? this.#committed : "";
        this.#articleId = loaded.id;
        this.#loadedVersion = loaded.version;
        this.#titleText = loaded.title;
        this.#versionsKnown = [...loaded.versions];
        this.#reopenId = loaded.id;
        this.#reopenTitle = loaded.title;
        this.#baseline = baseline;
        this.#committed = loaded.text;
        this.#title.textContent = loaded.title;
        this.#version.textContent = `v${loaded.version}`;
        this.#paintVersions();
        this.#paint(baseline, animate && (sequential || firstVersion), anchor);
        this.#view = this.#preferredView;
        this.#syncViews(baseline !== "");
        this.#syncSummary(baseline, loaded.version);
        this.#status.textContent = `${loaded.text.length} 字 · 第 ${loaded.version} 版`;
        this.#syncReopen();
        // Reopening a document, or stepping back through the version chips, skips
        // the hand-off the panel would otherwise have watched. Fetching the version
        // it replaced is what makes "对照上一版" mean something there too.
        if (baseline === "" && loaded.version > 1)
            void this.#loadBaseline(loaded.id, loaded.version);
    }
    async #loadBaseline(id, version) {
        const token = this.#token;
        const previous = await this.#load(id, version - 1);
        if (token !== this.#token || !previous)
            return;
        if (this.#articleId !== id || this.#loadedVersion !== version)
            return;
        this.#baseline = previous.text;
        this.#syncSummary(previous.text, version);
        this.#syncViews(true);
    }
    /**
     * The counts are a caption for the view, not the view itself: paragraphs while
     * reading the article, lines while reading the revision.
     */
    #syncSummary(baseline, version) {
        if (baseline === "") {
            this.#summary.hidden = true;
            return;
        }
        if (this.#view === "read") {
            const counts = articleChangeCounts(diffArticleBlocks(baseline, this.#committed));
            this.#summary.hidden = counts.added === 0 && counts.removed === 0;
            this.#summary.textContent = `相对第 ${version - 1} 版 +${counts.added} 段 −${counts.removed} 段`;
            return;
        }
        const counts = articleLineChangeCounts(diffArticleLines(baseline, this.#committed, "line"));
        this.#summary.hidden = counts.added === 0 && counts.removed === 0;
        this.#summary.textContent = `相对第 ${version - 1} 版 +${counts.added} 行 −${counts.removed} 行`;
    }
    /**
     * Draws the current view, keeping whatever the previous version already put on
     * screen.
     *
     * A new version is mostly the old one. Clearing the stage and rebuilding it
     * would throw away the reading position, any selection, and the very blocks
     * the reader is being asked to compare — so blocks are keyed by what they
     * render, unchanged ones keep their nodes, and only the difference moves:
     * dropped blocks fold away first, then new ones pulse in where they belong.
     */
    #paint(previous, animate, anchor) {
        const sequence = ++this.#paintSequence;
        const entries = this.#view === "read"
            ? this.#readEntries(previous)
            : this.#diffEntries(previous, this.#view === "line" ? "line" : "token");
        const wanted = new Set(entries.map((entry) => entry.key));
        const leaving = [...this.#nodes]
            .filter(([key, node]) => !wanted.has(key) && node.isConnected)
            .map(([, node]) => node);
        // A folded block is reused later, so the collapse must not outlive the exit.
        for (const node of leaving)
            node.dataset["leaving"] = "true";
        const commit = () => {
            if (sequence !== this.#paintSequence)
                return;
            this.#commit(entries, animate, anchor);
        };
        if (animate && leaving.length > 0 && leaving.length <= MAX_PULSED_BLOCKS)
            collapseArticleRemovals(leaving, commit);
        else
            commit();
    }
    #commit(entries, animate, anchor) {
        const pinned = anchor === "keep" && this.#pinnedToEnd();
        const children = [];
        const appeared = [];
        for (const entry of entries) {
            const reused = this.#nodes.get(entry.key);
            const node = reused ?? entry.build();
            if (node.dataset["leaving"] !== undefined) {
                // It was folded away on its way out; coming back has to undo that.
                delete node.dataset["leaving"];
                node.removeAttribute("style");
            }
            // What the reader sees appear is what was not on screen a moment ago,
            // whether it was just built or restored from the pool.
            if (!node.isConnected)
                appeared.push(node);
            // Re-inserting refreshes the entry's place in the eviction order.
            this.#nodes.delete(entry.key);
            this.#nodes.set(entry.key, node);
            children.push(node);
        }
        if (children.length === 0) {
            const empty = document.createElement("p");
            empty.className = "article-empty";
            empty.textContent = "这一版还没有正文";
            children.push(empty);
        }
        while (this.#nodes.size > BLOCK_POOL_SIZE) {
            const oldest = this.#nodes.keys().next().value;
            if (oldest === undefined)
                break;
            this.#nodes.delete(oldest);
        }
        reconcileChildren(this.#render, children);
        if (anchor === "top")
            this.#stage.scrollTop = 0;
        else if (pinned)
            this.#stage.scrollTop = this.#stage.scrollHeight;
        if (animate)
            pulseArticleChanges(appeared.slice(0, MAX_PULSED_BLOCKS));
    }
    /**
     * The article itself. Keys carry only what a block renders, not whether the
     * diff called it new, so a paragraph that was new in one version and settled
     * in the next keeps the node it already had.
     */
    #readEntries(previous) {
        return blockEntries(diffArticleBlocks(previous, this.#committed)
            .filter((block) => block.kind !== "remove")
            .map((block) => block.source));
    }
    #diffEntries(previous, granularity) {
        const seen = new Map();
        return diffArticleLines(previous, this.#committed, granularity).map((line) => {
            const marks = (line.segments ?? []).map((segment) => `${segment.kind}:${segment.text}`).join("\u0001");
            const signature = `diff\u0000${granularity}\u0000${line.kind}\u0000${line.number}\u0000${line.text}\u0000${marks}`;
            return { key: keyOf(seen, signature), build: () => diffLineNode(line) };
        });
    }
    /**
     * The draft, drawn through the same keyed blocks as a saved version.
     *
     * A revision is mostly the version before it, and the draft that becomes it is
     * too. Rendering it as its own thing would clear the stage the moment the
     * model starts writing — so by the time the version landed there was nothing
     * left to patch, and the whole document was drawn again.
     */
    #renderLive(text) {
        this.#paintSequence += 1;
        this.#commit(blockEntries(splitArticleBlocks(text)), false, "keep");
    }
    #paintVersions() {
        this.#versions.replaceChildren();
        for (const version of this.#versionsKnown) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "article-version";
            button.textContent = `v${version.version}`;
            button.setAttribute("aria-pressed", String(version.version === this.#loadedVersion));
            button.addEventListener("click", () => {
                if (version.version !== this.#loadedVersion)
                    void this.open(this.#articleId, version.version);
            });
            this.#versions.append(button);
        }
    }
    /**
     * One export at a time. The save dialog is modal to the window but the panel
     * is not, and a second click while the first dialog is open would queue
     * another one behind it and write the file twice.
     */
    async #export(format) {
        if (!this.#articleId || this.#loadedVersion < 1 || this.#exporting)
            return;
        this.#exporting = true;
        this.#syncExports();
        this.#status.textContent = "正在导出…";
        try {
            const result = await this.#exportArticle({ id: this.#articleId, version: this.#loadedVersion, format });
            this.#status.textContent = result.message;
        }
        catch (error) {
            this.#status.textContent = error instanceof Error ? error.message : "导出失败";
        }
        finally {
            this.#exporting = false;
            this.#syncExports();
        }
    }
    #syncExports() {
        for (const button of this.#exportButtons)
            button.disabled = this.#exporting;
    }
    async #refreshReopen(sessionId) {
        const token = this.#token;
        this.#reopenInFlight = true;
        let listed;
        try {
            listed = await this.#dispatch({ action: "article.list", sessionId });
        }
        catch {
            // Usually "daemon is not connected" during startup.
            this.#reopenInFlight = false;
            if (this.#reopenRetries < REOPEN_RETRY_LIMIT && sessionId === this.#sessionId()) {
                this.#reopenRetries += 1;
                window.setTimeout(() => this.onSessionChanged(), REOPEN_RETRY_MS);
            }
            return;
        }
        this.#reopenInFlight = false;
        this.#reopenRetries = 0;
        if (token !== this.#token || sessionId !== this.#sessionId())
            return;
        this.#reopenSession = sessionId;
        const articles = asRecord(listed)["articles"];
        const first = Array.isArray(articles) ? asRecord(articles[0]) : undefined;
        const id = stringValue(first?.["id"]);
        if (!id) {
            this.#reopenId = "";
            this.#reopenTitle = "";
        }
        else {
            this.#reopenId = id;
            this.#reopenTitle = stringValue(first?.["title"]) ?? "文稿";
        }
        this.#syncReopen();
    }
    async #load(id, version) {
        const text = await this.#readSlices((offset, limit) => this.#dispatch({
            action: "article.get",
            sessionId: this.#sessionId(),
            id,
            ...(version === undefined ? {} : { version }),
            offset,
            limit,
        }));
        if (text === undefined)
            return undefined;
        const head = await this.#dispatch({
            action: "article.get",
            sessionId: this.#sessionId(),
            id,
            ...(version === undefined ? {} : { version }),
            offset: 0,
            limit: 1,
        });
        const record = asRecord(head);
        if (typeof record["title"] !== "string" || typeof record["version"] !== "number")
            return undefined;
        const versions = Array.isArray(record["versions"])
            ? record["versions"].flatMap((entry) => {
                const versionRecord = asRecord(entry);
                return typeof versionRecord["version"] === "number"
                    ? [{ version: versionRecord["version"], chars: typeof versionRecord["chars"] === "number" ? versionRecord["chars"] : 0 }]
                    : [];
            })
            : [{ version: record["version"], chars: text.length }];
        return { id, title: record["title"], version: record["version"], versions, text };
    }
    async #readSlices(fetchSlice) {
        return readFullMessage(fetchSlice);
    }
    #show(title) {
        const wasOpen = this.#open;
        this.#open = true;
        this.#panel.hidden = false;
        document.documentElement.dataset["article"] = "open";
        if (title)
            this.#title.textContent = title;
        if (!wasOpen) {
            slideArticlePanel(this.#panel);
            this.#onLayout();
        }
        this.#syncReopen();
    }
    /**
     * The first version has nothing to compare against, so the revision views stay
     * out of reach until there is a baseline to compare with.
     */
    #syncViews(comparable) {
        if (!comparable && this.#view !== "read")
            this.#view = "read";
        this.#panel.dataset["view"] = this.#view;
        for (const button of this.#viewButtons) {
            const view = button.dataset["view"];
            button.disabled = !comparable && view !== "read";
            button.setAttribute("aria-pressed", String(view === this.#view));
        }
    }
    #syncReopen() {
        const visible = !this.#open && this.#reopenId !== "";
        this.#reopen.hidden = !visible;
        this.#reopen.textContent = this.#reopenTitle || "文稿";
    }
    #pinnedToEnd() {
        return this.#stage.scrollHeight - this.#stage.scrollTop - this.#stage.clientHeight < 48;
    }
}
function requiredElement(id) {
    const element = document.getElementById(id);
    if (!element)
        throw new Error(`Missing #${id}`);
    return element;
}
function requiredButton(id) {
    const element = requiredElement(id);
    if (!(element instanceof HTMLButtonElement))
        throw new Error(`#${id} is not a button`);
    return element;
}
function toolResultText(result) {
    const content = asRecord(result)["content"];
    if (!Array.isArray(content))
        return "";
    return content.map((block) => {
        const text = asRecord(block)["text"];
        return typeof text === "string" ? text : "";
    }).filter(Boolean).join("\n");
}
function asRecord(value) {
    return typeof value === "object" && value !== null ? value : {};
}
function stringValue(value) {
    return typeof value === "string" && value.trim() ? value : undefined;
}
//# sourceMappingURL=article-panel.js.map