/// <reference lib="DOM" />
import { articleChangeCounts, diffArticleBlocks } from "../../articles/diff.js";
import { parseArticleReceipt } from "../../articles/receipt.js";
import { readFullMessage } from "../../ui/shared/full-message.js";
import { appendMarkdown } from "./markdown-view.js";
import { pulseArticleChanges, slideArticlePanel } from "./motion.js";
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
    #diffToggle;
    #reopen;
    #open = false;
    #diffMode = false;
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
        this.#diffToggle = requiredButton("article-diff-toggle");
        this.#reopen = requiredButton("open-article-button");
        requiredButton("article-close").addEventListener("click", () => this.close());
        this.#diffToggle.addEventListener("click", () => {
            this.#diffMode = !this.#diffMode;
            this.#diffToggle.setAttribute("aria-pressed", String(this.#diffMode));
            this.#diffToggle.textContent = this.#diffMode ? "只看正文" : "对照上一版";
            if (this.#articleId)
                this.#paint(this.#baseline, false);
        });
        this.#reopen.addEventListener("click", () => {
            if (this.#reopenId)
                void this.open(this.#reopenId);
        });
        for (const button of Array.from(this.#panel.querySelectorAll("[data-export]"))) {
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
    onSessionChanged() {
        const sessionId = this.#sessionId();
        if (sessionId === this.#session)
            return;
        this.#session = sessionId;
        this.#token += 1;
        this.#writing = false;
        this.close();
        void this.#refreshReopen();
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
        this.#applyLoaded(loaded, true);
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
        this.#applyLoaded(loaded, true);
    }
    #applyLoaded(loaded, animate) {
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
        this.#paint(baseline, animate && (sequential || firstVersion));
        const counts = articleChangeCounts(diffArticleBlocks(baseline, loaded.text));
        this.#summary.hidden = baseline === "" || (counts.added === 0 && counts.removed === 0);
        this.#summary.textContent = `相对上一版 +${counts.added} 段 −${counts.removed} 段`;
        this.#status.textContent = `${loaded.text.length} 字 · 第 ${loaded.version} 版`;
        this.#syncReopen();
    }
    #paint(previous, animate) {
        const pinned = this.#pinnedToEnd();
        const diff = diffArticleBlocks(previous, this.#committed);
        this.#render.replaceChildren();
        const added = [];
        for (const block of diff) {
            if (block.kind === "remove" && !this.#diffMode)
                continue;
            const wrap = document.createElement("div");
            wrap.className = block.kind === "remove" ? "article-removed" : "article-block";
            if (block.kind === "add") {
                wrap.dataset["change"] = "add";
                added.push(wrap);
            }
            if (block.kind === "remove")
                wrap.textContent = block.source;
            else
                appendMarkdown(wrap, block.source);
            this.#render.append(wrap);
        }
        if (this.#render.childElementCount === 0) {
            const empty = document.createElement("p");
            empty.className = "article-empty";
            empty.textContent = "这一版还没有正文";
            this.#render.append(empty);
        }
        if (pinned)
            this.#stage.scrollTop = this.#stage.scrollHeight;
        if (animate)
            pulseArticleChanges(added.slice(0, 16));
    }
    #renderLive(text) {
        const pinned = this.#pinnedToEnd();
        this.#render.replaceChildren();
        appendMarkdown(this.#render, text);
        if (pinned)
            this.#stage.scrollTop = this.#stage.scrollHeight;
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
    async #export(format) {
        if (!this.#articleId || this.#loadedVersion < 1)
            return;
        this.#status.textContent = "正在导出…";
        try {
            const result = await this.#exportArticle({ id: this.#articleId, version: this.#loadedVersion, format });
            this.#status.textContent = result.message;
        }
        catch (error) {
            this.#status.textContent = error instanceof Error ? error.message : "导出失败";
        }
    }
    async #refreshReopen() {
        const token = this.#token;
        const listed = await this.#dispatch({ action: "article.list", sessionId: this.#sessionId() });
        if (token !== this.#token)
            return;
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