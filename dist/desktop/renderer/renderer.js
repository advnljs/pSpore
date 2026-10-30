/// <reference lib="DOM" />
import { publishedTextTruncation } from "../../protocol/limits.js";
import { defaultModelFor } from "../../settings/llm-settings.js";
import { clockTime, conversationIntent, formatBytes, formatTokens, kernelMetrics, listTime, presentSessions, selectedAgent as findSelectedAgent, shortId, terminalAgentStatus, } from "../../ui/shared/presentation.js";
import { readFullMessage } from "../../ui/shared/full-message.js";
import { isScrollNearEnd, VirtualHeightIndex } from "../../ui/shared/virtual-list.js";
import { DAEMON_NOT_CONNECTED_MESSAGE, } from "../ipc-contract.js";
import { composeMessageWithFileReferences, composerFileReference, composerFileReferenceName, mergeComposerFileReferences, } from "./composer-file-references.js";
import { parseArticleReceipt } from "../../articles/receipt.js";
import { ArticlePanel } from "./article-panel.js";
import { formatElapsed, presentIndexing } from "./indexing-view.js";
import { reconcileChildren } from "./dom-reconcile.js";
import { appendMarkdown, createMarkdownSurface } from "./markdown-view.js";
import { createSessionSearch } from "./session-search.js";
import { animateMessagesIn, animateTranscriptHero, crossfadeText, flipStatusChip, hideOverlayMotion, introChoreography, nudgeElement, popChips, pulseStatus, revealListItems, revealPanel, setReconnectingPulse, showOverlayMotion, toggleBannerMotion, tweenMetric, } from "./motion.js";
import { CONNECTION_SETTLE_MS, DesktopStore } from "./store.js";
const store = new DesktopStore();
const queuedFrames = [];
let initialized = false;
let versions;
let jobs = [];
let resources = [];
/** The fixed tools this build ships, as reported by the daemon. */
let builtinTools = [];
/** Every skill new sessions are offered, and the ones found but not loaded. */
let skillCatalog = [];
const SKILL_SOURCE_LABELS = {
    installed: "已安装",
    bundled: "内置",
    workspace: "本地",
};
let inspection;
let activeApprovalId;
let renderSequence = 0;
let settingsOpen = false;
let savingSettings = false;
let responsiveMode;
let introPlayed = false;
let lastConnectionPhase = "";
let settleTimer;
let lastSessionSignature = "";
let lastSessionStatus = "";
let lastActivitySignature = "";
let lastReferenceCount = 0;
let indexingDirectories = [];
/** Session whose delete control is armed, so a stray click cannot destroy history. */
let armedSessionDeletion;
let armSessionDeletionTimer;
let renderFrame;
let transcriptRenderFrame;
let composerFileReferences = [];
/** Well-known directories, filled in by the Electron main process at bootstrap. */
let desktopPlaces;
/** How long a delete control stays armed before it reverts on its own. */
const SESSION_DELETE_ARM_MS = 5_000;
/**
 * The run phase currently on screen and when it began.
 *
 * Elapsed time is measured here rather than taken from the daemon because what
 * the reader is asking is "how long has this been showing me nothing", which is
 * a question about their own screen.
 */
let activityPhase;
let activityTicker;
let indexingTicker;
const transcriptState = {
    sessionId: "",
    end: -1,
    loadingHistory: false,
    heights: new VirtualHeightIndex(180),
    nodes: new Map(),
    measureFrame: undefined,
    messageSource: undefined,
    items: [],
    hasStreaming: false,
    followTail: true,
    pinnedIndex: undefined,
    spacerStart: virtualSpacer("start"),
    spacerEnd: virtualSpacer("end"),
    stream: undefined,
};
const THEME_STORAGE_KEY = "pspore.desktop.theme";
/** Distance from the top that triggers loading the page before the tail. */
const HISTORY_BACKFILL_TRIGGER_PX = 240;
const HISTORY_PAGE_SIZE = 200;
/** How many restored full messages are kept, so scrollback cannot grow forever. */
const FULL_TEXT_CACHE_ENTRIES = 4;
/**
 * Full text for messages the daemon had to cut, keyed by session and message.
 * Bounded, and dropped oldest-first: restoring a few very long messages must not
 * turn the transcript into an unbounded buffer.
 */
const fullMessageTexts = new Map();
const loadingFullText = new Set();
const elements = {
    appShell: byId("app-shell"),
    topbar: document.querySelector(".topbar") ?? missingElement(".topbar"),
    conversationPanel: document.querySelector(".conversation") ?? missingElement(".conversation"),
    navigationPanel: byId("navigation-panel"),
    navigationToggle: byId("navigation-toggle"),
    inspectorPanel: byId("inspector-panel"),
    inspectorToggle: byId("inspector-toggle"),
    inspectorClose: byId("inspector-close"),
    inspectorTabs: Array.from(document.querySelectorAll("[data-inspector-tab]")),
    inspectorViews: Array.from(document.querySelectorAll("[data-inspector-panel]")),
    connectionBadge: byId("connection-badge"),
    daemonInstance: byId("daemon-instance"),
    revision: byId("revision-value"),
    usage: byId("usage-value"),
    cache: byId("cache-value"),
    themeToggle: byId("theme-toggle"),
    themeColor: byId("theme-color"),
    refresh: byId("refresh-button"),
    connectionBanner: byId("connection-banner"),
    connectionMessage: byId("connection-message"),
    sessionCount: byId("session-count"),
    newSession: byId("new-session-button"),
    sessionList: byId("session-list"),
    runActivity: byId("run-activity"),
    runActivityMark: byId("run-activity-mark"),
    runActivityLabel: byId("run-activity-label"),
    runActivityElapsed: byId("run-activity-elapsed"),
    indexingPanel: byId("indexing-panel"),
    indexingPhase: byId("indexing-phase"),
    indexingBarFill: byId("indexing-bar-fill"),
    indexingCounts: byId("indexing-counts"),
    indexingCurrent: byId("indexing-current"),
    indexingNote: byId("indexing-note"),
    railRuns: byId("rail-runs"),
    railMcp: byId("rail-mcp"),
    railResources: byId("rail-resources"),
    railApprovals: byId("rail-approvals"),
    agentCompose: byId("agent-compose"),
    agentComposeToggle: byId("agent-compose-toggle"),
    agentComposeClose: byId("agent-compose-close"),
    spawnForm: byId("spawn-form"),
    spawnObjective: byId("spawn-objective"),
    childControls: byId("child-controls"),
    joinAgent: byId("join-agent-button"),
    cancelAgent: byId("cancel-agent-button"),
    inspectForm: byId("inspect-form"),
    stagingName: byId("staging-name"),
    inspectionResult: byId("inspection-result"),
    resourceShortcut: byId("resource-shortcut"),
    versionLine: byId("version-line"),
    runtimeLine: byId("runtime-line"),
    sessionTitle: byId("session-title"),
    sessionSearchButton: byId("session-search-button"),
    sessionSearch: byId("session-search"),
    sessionSearchInput: byId("session-search-input"),
    sessionSearchCount: byId("session-search-count"),
    sessionSearchPrevious: byId("session-search-prev"),
    sessionSearchNext: byId("session-search-next"),
    sessionSearchClose: byId("session-search-close"),
    sessionStatus: byId("session-status"),
    modelName: byId("model-name"),
    transcript: byId("transcript"),
    notice: byId("notice-line"),
    messageQueue: byId("message-queue"),
    composerForm: byId("composer-form"),
    composerInput: byId("composer-input"),
    composerDropOverlay: byId("composer-drop-overlay"),
    composerReferences: byId("composer-references"),
    compact: byId("compact-button"),
    abort: byId("abort-button"),
    send: byId("send-button"),
    activityCount: byId("activity-count"),
    activityList: byId("activity-list"),
    jobList: byId("job-list"),
    runList: byId("run-list"),
    integrationList: byId("integration-list"),
    notificationList: byId("notification-list"),
    settingsButton: byId("settings-button"),
    settingsOverlay: byId("settings-overlay"),
    settingsDialog: document.querySelector(".settings-dialog") ?? missingElement(".settings-dialog"),
    settingsClose: byId("settings-close"),
    settingsCancel: byId("settings-cancel"),
    settingsForm: byId("settings-form"),
    settingsProvider: byId("settings-provider"),
    settingsProviderHelp: byId("settings-provider-help"),
    settingsModel: byId("settings-model"),
    settingsBaseUrl: byId("settings-base-url"),
    settingsApi: byId("settings-api"),
    settingsThinking: byId("settings-thinking"),
    settingsPermissionMode: byId("settings-permission-mode"),
    settingsPermissionHelp: byId("settings-permission-help"),
    settingsPermissionWarning: byId("settings-permission-warning"),
    settingsAutoCompaction: byId("settings-auto-compaction"),
    settingsCompactionTrigger: byId("settings-compaction-trigger"),
    settingsCompactionReserve: byId("settings-compaction-reserve"),
    settingsCompactionKeepRecent: byId("settings-compaction-keep-recent"),
    settingsApiKey: byId("settings-api-key"),
    settingsKeyReveal: byId("settings-key-reveal"),
    settingsClearKey: byId("settings-clear-key"),
    settingsCookie: byId("settings-cookie"),
    settingsCookieReveal: byId("settings-cookie-reveal"),
    settingsClearCookie: byId("settings-clear-cookie"),
    settingsConfigPath: byId("settings-config-path"),
    settingsModelsPath: byId("settings-models-path"),
    settingsApiKeyPath: byId("settings-api-key-path"),
    settingsApiKeyState: byId("settings-api-key-state"),
    settingsKeyCopyPath: byId("settings-key-copy-path"),
    settingsCookiePath: byId("settings-cookie-path"),
    attachFile: byId("attach-file-button"),
    attachDirectory: byId("attach-directory-button"),
    settingsHeaderList: byId("settings-header-list"),
    settingsHeaderAdd: byId("settings-header-add"),
    settingsCookieState: byId("settings-cookie-state"),
    settingsCookieCopyPath: byId("settings-cookie-copy-path"),
    settingsIndexingEnabled: byId("settings-indexing-enabled"),
    settingsIndexingInterval: byId("settings-indexing-interval"),
    settingsIndexingExt: byId("settings-indexing-ext"),
    settingsIndexingAdd: byId("settings-indexing-add"),
    settingsIndexingList: byId("settings-indexing-list"),
    settingsIndexingNote: byId("settings-indexing-note"),
    settingsStatus: byId("settings-status"),
    settingsSave: byId("settings-save"),
    approvalOverlay: byId("approval-overlay"),
    approvalDialog: document.querySelector(".approval-dialog") ?? missingElement(".approval-dialog"),
    approvalTitle: byId("approval-title"),
    approvalSummary: byId("approval-summary"),
    approvalCapability: byId("approval-capability"),
    approvalTarget: byId("approval-target"),
    approvalReasons: byId("approval-reasons"),
    approvalCommand: byId("approval-command"),
    approvalActions: byId("approval-actions"),
};
const sessionSearch = createSessionSearch({
    bar: elements.sessionSearch,
    input: elements.sessionSearchInput,
    count: elements.sessionSearchCount,
    button: elements.sessionSearchButton,
    previous: elements.sessionSearchPrevious,
    next: elements.sessionSearchNext,
    close: elements.sessionSearchClose,
    transcript: elements.transcript,
    requestRender: () => scheduleTranscriptRender(),
    getTexts: () => currentSessionTexts(store.snapshot()),
    getSessionId: () => store.snapshot().selectedSessionId,
    getOffset: (index) => transcriptState.heights.offsetAt(index),
    setFollowTail: (value) => {
        transcriptState.followTail = value;
    },
    setPinnedIndex: (index) => {
        transcriptState.pinnedIndex = index;
    },
    forEachMessage: (visit) => {
        for (const node of transcriptState.nodes.values())
            visit(node);
        if (transcriptState.stream)
            visit(transcriptState.stream.node);
    },
    isModalOpen: () => !elements.settingsOverlay.hidden || !elements.approvalOverlay.hidden,
});
applyTheme(initialTheme());
syncResponsivePanels(true);
const articles = new ArticlePanel({
    sessionId: () => store.snapshot().selectedSessionId,
    dispatch: (command) => window.pspore.dispatch(command),
    exportArticle: (request) => window.pspore.exportArticle(request),
    onLayout: () => scheduleResizeReflow(),
});
const unsubscribe = window.pspore.subscribe((frame) => {
    if (frame.kind === "event")
        articles.onEvent(frame.event);
    if (!initialized)
        queuedFrames.push(frame);
    else {
        store.applyFrame(frame);
        // The selection can change without anyone clicking: a restored session
        // arrives with the first snapshot, and a reconnect replaces it. The panel
        // no-ops when nothing changed.
        articles.onSessionChanged();
        scheduleRender();
    }
});
window.addEventListener("beforeunload", unsubscribe, { once: true });
void initialize();
async function initialize() {
    bindStaticActions();
    try {
        const bootstrap = await window.pspore.bootstrap();
        versions = bootstrap.versions;
        desktopPlaces = bootstrap.places;
        store.applyBootstrap(bootstrap);
        articles.onSessionChanged();
        initialized = true;
        for (const frame of queuedFrames.splice(0))
            store.applyFrame(frame);
        articles.onSessionChanged();
        render();
        await refreshSideData();
    }
    catch (error) {
        initialized = true;
        store.setNotice(`桌面初始化失败：${toError(error).message}`);
        render();
    }
    finally {
        document.documentElement.dataset["ready"] = "true";
        playIntroOnce();
    }
}
function playIntroOnce() {
    if (introPlayed)
        return;
    introPlayed = true;
    introChoreography(elements.topbar, [elements.navigationPanel, elements.conversationPanel, elements.inspectorPanel]);
}
function bindStaticActions() {
    elements.navigationToggle.addEventListener("click", () => {
        setPanelState("navigation", document.documentElement.dataset["navigation"] !== "open");
    });
    elements.inspectorToggle.addEventListener("click", () => {
        if (articles.isOpen()) {
            articles.close();
            setPanelState("inspector", true);
            return;
        }
        setPanelState("inspector", document.documentElement.dataset["inspector"] !== "open");
    });
    elements.inspectorClose.addEventListener("click", () => setPanelState("inspector", false));
    for (const tab of elements.inspectorTabs) {
        tab.addEventListener("click", () => selectInspectorTab(tab.dataset["inspectorTab"]));
    }
    elements.agentComposeToggle.addEventListener("click", () => setAgentCompose(elements.agentCompose.hidden));
    elements.agentComposeClose.addEventListener("click", () => setAgentCompose(false));
    elements.resourceShortcut.addEventListener("click", () => {
        if (articles.isOpen())
            articles.close();
        selectInspectorTab("resources");
        setPanelState("inspector", true);
    });
    window.addEventListener("resize", () => {
        syncResponsivePanels(false);
        scheduleResizeReflow();
    });
    elements.themeToggle.addEventListener("click", () => {
        const theme = document.documentElement.dataset["theme"] === "light" ? "dark" : "light";
        applyTheme(theme);
        try {
            window.localStorage.setItem(THEME_STORAGE_KEY, theme);
        }
        catch {
            // Theme remains active for this session when local persistence is unavailable.
        }
    });
    elements.refresh.addEventListener("click", () => void refreshSideData());
    elements.newSession.addEventListener("click", () => {
        void perform("新建会话", { action: "session.create" }, (result) => {
            if (!isSessionView(result))
                throw new Error("服务返回了无效的会话");
            store.selectSession(result.sessionId);
            articles.onSessionChanged();
            elements.composerInput.focus();
        });
    });
    elements.settingsButton.addEventListener("click", () => void openSettings());
    elements.settingsClose.addEventListener("click", () => closeSettings());
    elements.settingsCancel.addEventListener("click", () => closeSettings());
    elements.settingsForm.addEventListener("submit", (event) => {
        event.preventDefault();
        void saveSettings();
    });
    elements.settingsProvider.addEventListener("change", () => configureProviderFields(true));
    elements.settingsPermissionMode.addEventListener("change", () => configurePermissionFields());
    bindSecretField(elements.settingsApiKey, elements.settingsKeyReveal, elements.settingsClearKey);
    bindSecretField(elements.settingsCookie, elements.settingsCookieReveal, elements.settingsClearCookie);
    bindPathCopy(elements.settingsKeyCopyPath, elements.settingsApiKeyPath);
    elements.settingsIndexingAdd.addEventListener("click", () => void addIndexingDirectory());
    bindPathCopy(elements.settingsCookieCopyPath, elements.settingsCookiePath);
    elements.settingsHeaderAdd.addEventListener("click", () => addCustomHeaderRow("", false));
    elements.attachFile.addEventListener("click", () => void chooseAttachments("file"));
    elements.attachDirectory.addEventListener("click", () => void chooseAttachments("directory"));
    elements.settingsOverlay.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !savingSettings) {
            event.preventDefault();
            closeSettings();
            return;
        }
        trapDialogFocus(event, elements.settingsDialog);
    });
    elements.composerForm.addEventListener("submit", (event) => {
        event.preventDefault();
        void submitComposer();
    });
    elements.composerInput.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.isComposing)
            return;
        // Enter sends; Ctrl/Cmd+Enter, Shift+Enter and Alt+Enter insert a newline.
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
            return;
        event.preventDefault();
        elements.composerForm.requestSubmit();
    });
    bindComposerFileDrop();
    elements.transcript.addEventListener("scroll", handleTranscriptScroll, { passive: true });
    elements.spawnForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const objective = elements.spawnObjective.value.trim();
        if (!objective)
            return;
        const snapshot = store.snapshot();
        const parentId = selectedAgent(snapshot)?.rootId ?? snapshot.selectedSessionId;
        void perform("启动子 Agent", { action: "agent.spawn", objective, parentId }, () => {
            elements.spawnObjective.value = "";
            setAgentCompose(false);
            return refreshSideData();
        });
    });
    elements.abort.addEventListener("click", () => {
        const snapshot = store.snapshot();
        const child = selectedAgent(snapshot);
        const command = child
            ? { action: "agent.cancel", agentId: child.id }
            : { action: "abort", sessionId: snapshot.selectedSessionId };
        void perform(child ? `取消 ${child.id}` : "中止主会话", command);
    });
    elements.compact.addEventListener("click", () => {
        const sessionId = store.snapshot().selectedSessionId;
        void perform("压缩会话上下文", { action: "compact", sessionId });
    });
    elements.joinAgent.addEventListener("click", () => {
        const child = selectedAgent(store.snapshot());
        if (child)
            void perform(`等待 ${child.id} 完成`, { action: "agent.join", agentIds: [child.id] });
    });
    elements.cancelAgent.addEventListener("click", () => {
        const child = selectedAgent(store.snapshot());
        if (child)
            void perform(`取消 ${child.id}`, { action: "agent.cancel", agentId: child.id });
    });
    elements.inspectForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const stagingName = elements.stagingName.value.trim();
        if (!stagingName)
            return;
        void perform("检查暂存资源", { action: "resources.inspect", stagingName }, (result) => {
            inspection = isInspection(result) ? result : undefined;
            renderInspection();
        });
    });
    elements.approvalOverlay.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            return;
        }
        trapDialogFocus(event, elements.approvalOverlay);
    });
}
function bindComposerFileDrop() {
    elements.composerForm.addEventListener("dragenter", (event) => {
        if (!hasDraggedFiles(event.dataTransfer))
            return;
        event.preventDefault();
        setComposerDropActive(true);
    });
    elements.composerForm.addEventListener("dragover", (event) => {
        if (!hasDraggedFiles(event.dataTransfer))
            return;
        event.preventDefault();
        if (event.dataTransfer)
            event.dataTransfer.dropEffect = "copy";
        setComposerDropActive(true);
    });
    elements.composerForm.addEventListener("dragleave", (event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && elements.composerForm.contains(nextTarget))
            return;
        setComposerDropActive(false);
    });
    elements.composerForm.addEventListener("drop", (event) => {
        if (!hasDraggedFiles(event.dataTransfer))
            return;
        event.preventDefault();
        event.stopPropagation();
        setComposerDropActive(false);
        addComposerFileReferences(droppedComposerFileReferences(event.dataTransfer));
    });
    window.addEventListener("dragend", () => setComposerDropActive(false));
}
/**
 * The same references a drop produces, chosen from a native dialog instead.
 * Dragging is not always possible — a folder the user reaches through a file
 * manager's tree, a window that cannot be arranged side by side — and the
 * renderer has no path of its own to offer.
 *
 * Files and directories are separate buttons because they are separate dialogs:
 * the GTK chooser answers a request for both with directories only.
 */
async function chooseAttachments(kind) {
    let chosen;
    try {
        chosen = await window.pspore.pickAttachments(kind);
    }
    catch (error) {
        store.setNotice(`无法打开选择器：${toError(error).message}`);
        render();
        return;
    }
    if (chosen.length === 0)
        return;
    addComposerFileReferences(chosen.flatMap((entry) => {
        const reference = composerFileReference(entry.path, entry.kind);
        return reference ? [reference] : [];
    }));
}
/** Merges references into the composer and says what happened, for drops and the chooser alike. */
function addComposerFileReferences(incoming) {
    const merged = mergeComposerFileReferences(composerFileReferences, incoming);
    composerFileReferences = merged.references;
    renderComposerFileReferences();
    if (merged.added > 0) {
        const ignored = merged.skipped > 0 ? `；另有 ${merged.skipped} 个重复引用或超出上限` : "";
        store.setNotice(`已添加 ${merged.added} 个文件/目录引用，仅会发送路径${ignored}`);
    }
    else {
        store.setNotice(incoming.length > 0 ? "这些路径已经引用，未重复添加" : "未能获取本地文件或目录路径");
    }
    render();
    elements.composerInput.focus();
}
function hasDraggedFiles(transfer) {
    if (!transfer)
        return false;
    return Array.from(transfer.types).includes("Files") || Array.from(transfer.items).some((item) => item.kind === "file");
}
function setComposerDropActive(active) {
    elements.composerForm.dataset["dropActive"] = String(active);
    elements.composerDropOverlay.hidden = !active;
}
function droppedComposerFileReferences(transfer) {
    if (!transfer)
        return [];
    const references = new Map();
    const add = (file, kind) => {
        if (!file)
            return;
        try {
            const reference = composerFileReference(window.pspore.getPathForFile(file), kind);
            if (reference && !references.has(reference.path))
                references.set(reference.path, reference);
        }
        catch {
            // Browser-created Files have no operating-system path and are not valid references.
        }
    };
    for (const item of Array.from(transfer.items)) {
        if (item.kind !== "file")
            continue;
        let kind = "file";
        try {
            if (item.webkitGetAsEntry()?.isDirectory)
                kind = "directory";
        }
        catch {
            // The path remains usable even when Chromium cannot expose entry metadata.
        }
        add(item.getAsFile(), kind);
    }
    for (const file of Array.from(transfer.files))
        add(file, "file");
    return [...references.values()];
}
function renderComposerFileReferences() {
    const nodes = composerFileReferences.map((reference) => {
        const item = element("div", "composer-reference");
        item.setAttribute("role", "listitem");
        item.setAttribute("aria-label", `${reference.kind === "directory" ? "目录" : "文件"} ${reference.path}`);
        item.dataset["kind"] = reference.kind;
        const kind = element("span", "composer-reference-kind");
        kind.textContent = reference.kind === "directory" ? "目录" : "文件";
        const path = element("span", "composer-reference-path");
        path.textContent = composerFileReferenceName(reference.path);
        path.title = reference.path;
        const remove = element("button", "composer-reference-remove");
        remove.type = "button";
        remove.textContent = "×";
        remove.title = "移除引用";
        remove.setAttribute("aria-label", `移除引用 ${composerFileReferenceName(reference.path)}`);
        remove.addEventListener("click", () => {
            composerFileReferences = composerFileReferences.filter((candidate) => candidate.path !== reference.path);
            renderComposerFileReferences();
            elements.composerInput.focus();
        });
        item.append(kind, path, remove);
        return item;
    });
    const added = nodes.length > lastReferenceCount;
    lastReferenceCount = nodes.length;
    elements.composerReferences.replaceChildren(...nodes);
    elements.composerReferences.hidden = nodes.length === 0;
    if (added)
        popChips(nodes);
}
/**
 * Re-lays the transcript out after the window changed size.
 *
 * The transcript is a variable-height virtual list, and every height in its index
 * was measured at the previous width. A resize invalidates all of them at once:
 * messages rewrap, so the spacers keep reserving space for a layout that no
 * longer exists and the conversation stops tracking the window. Nothing else
 * re-rendered on resize either — `syncResponsivePanels` returns early while the
 * breakpoint is unchanged, so dragging a window within one band redrew nothing.
 *
 * Debounced because a drag emits a resize per frame, and re-measuring the whole
 * transcript on each one would fight the drag.
 */
let resizeReflowTimer;
function scheduleResizeReflow() {
    if (resizeReflowTimer !== undefined)
        window.clearTimeout(resizeReflowTimer);
    resizeReflowTimer = window.setTimeout(() => {
        resizeReflowTimer = undefined;
        // Dropping the index rather than re-measuring what is on screen: the items
        // outside the viewport rewrapped too, and their stale heights are what put
        // the scroll extent wrong. `messageSource` is cleared with it because the
        // render only re-syncs the index when the messages themselves changed, and a
        // fresh index that is never synced holds no items at all.
        transcriptState.heights = new VirtualHeightIndex(180);
        transcriptState.messageSource = undefined;
        render();
    }, RESIZE_REFLOW_MS);
}
/** Long enough that a drag settles first, short enough to feel immediate. */
const RESIZE_REFLOW_MS = 120;
function syncResponsivePanels(force) {
    // Only a full desktop viewport has room for all three columns; narrower windows keep the conversation dominant.
    const width = window.innerWidth;
    const nextMode = width <= 1_160 ? "narrow" : width <= 1_320 ? "compact" : width < 1_600 ? "wide" : "expansive";
    if (!force && nextMode === responsiveMode)
        return;
    responsiveMode = nextMode;
    setPanelState("navigation", nextMode !== "narrow");
    setPanelState("inspector", nextMode === "expansive");
}
function setPanelState(panel, open) {
    document.documentElement.dataset[panel] = open ? "open" : "closed";
    const button = panel === "navigation" ? elements.navigationToggle : elements.inspectorToggle;
    button.setAttribute("aria-expanded", String(open));
    const label = panel === "navigation"
        ? open ? "收起会话栏" : "展开会话栏"
        : open ? "收起检查器" : "展开检查器";
    button.setAttribute("aria-label", label);
    button.title = label;
}
function selectInspectorTab(selected) {
    for (const tab of elements.inspectorTabs) {
        const active = tab.dataset["inspectorTab"] === selected;
        tab.classList.toggle("selected", active);
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
    }
    for (const view of elements.inspectorViews) {
        const active = view.dataset["inspectorPanel"] === selected;
        const becameVisible = active && view.hidden;
        view.hidden = !active;
        if (becameVisible)
            revealPanel(view);
    }
}
function setAgentCompose(open) {
    elements.agentCompose.hidden = !open;
    elements.agentComposeToggle.setAttribute("aria-expanded", String(open));
    if (open)
        requestAnimationFrame(() => elements.spawnObjective.focus());
}
async function openSettings() {
    if (!elements.approvalOverlay.hidden)
        return;
    settingsOpen = true;
    elements.settingsOverlay.hidden = false;
    showOverlayMotion(elements.settingsOverlay, elements.settingsDialog);
    elements.settingsStatus.textContent = "读取设置中…";
    elements.settingsSave.disabled = true;
    updateAppInert();
    requestAnimationFrame(() => elements.settingsClose.focus());
    try {
        const [settings, indexing] = await Promise.all([
            window.pspore.getSettings(),
            window.pspore.getIndexing(),
        ]);
        populateSettings(settings);
        populateIndexingSettings(indexing);
        elements.settingsStatus.textContent = settingsStatus(settings);
        elements.settingsSave.disabled = false;
    }
    catch (error) {
        elements.settingsStatus.textContent = `读取失败：${toError(error).message}`;
    }
}
function populateIndexingSettings(indexing) {
    elements.settingsIndexingEnabled.checked = indexing.enabled;
    elements.settingsIndexingInterval.value = String(indexing.intervalMinutes);
    elements.settingsIndexingExt.value = indexing.extensions.join(",");
    indexingDirectories = [...indexing.directories];
    renderIndexingDirectories();
    elements.settingsIndexingNote.textContent = indexingSettingsNote(indexing);
}
/**
 * Says in the settings panel itself why a ticked checkbox may still not index
 * anything, so it agrees with what the status panel reports.
 */
function indexingSettingsNote(indexing) {
    const notes = [
        indexing.indexerAvailable
            ? `索引程序：${indexing.indexerPath}`
            : `本次发行版未包含索引程序（${indexing.indexerPath}），启用后会报告不可用。`,
    ];
    if (indexing.enabled && indexing.directories.length === 0) {
        notes.push("已启用，但还没有选择目录，索引不会运行。");
    }
    return notes.join(" ");
}
function renderIndexingDirectories() {
    elements.settingsIndexingList.replaceChildren(...indexingDirectories.map((directory) => {
        const row = element("div", "indexing-dir");
        row.setAttribute("role", "listitem");
        const path = element("code");
        path.textContent = directory;
        const remove = element("button", "quiet-text-button");
        remove.type = "button";
        remove.textContent = "移除";
        remove.setAttribute("aria-label", `移除索引目录 ${directory}`);
        remove.addEventListener("click", () => {
            indexingDirectories = indexingDirectories.filter((candidate) => candidate !== directory);
            renderIndexingDirectories();
        });
        row.append(path, remove);
        return row;
    }));
}
async function addIndexingDirectory() {
    // The renderer has no filesystem access, so the absolute path can only come
    // from the main process's native chooser.
    const directory = await window.pspore.pickIndexDirectory();
    if (!directory || indexingDirectories.includes(directory))
        return;
    indexingDirectories = [...indexingDirectories, directory].sort();
    renderIndexingDirectories();
    popChips(Array.from(elements.settingsIndexingList.children));
}
function populateSettings(settings) {
    elements.settingsProvider.value = settings.provider;
    elements.settingsModel.value = settings.model;
    elements.settingsBaseUrl.value = settings.baseUrl;
    elements.settingsApi.value = settings.api;
    elements.settingsThinking.value = settings.thinking;
    elements.settingsPermissionMode.value = settings.permissionMode;
    elements.settingsAutoCompaction.checked = settings.autoCompactionEnabled;
    elements.settingsCompactionTrigger.value = String(settings.autoCompactionTriggerTokens);
    elements.settingsCompactionReserve.value = String(settings.autoCompactionReserveTokens);
    elements.settingsCompactionKeepRecent.value = String(settings.autoCompactionKeepRecentTokens);
    populateSettingsPaths(settings);
    configurePermissionFields();
    configureProviderFields(false);
    resetSecretField(elements.settingsApiKey, elements.settingsKeyReveal, elements.settingsClearKey, settings.hasApiKey, "API Key");
    resetSecretField(elements.settingsCookie, elements.settingsCookieReveal, elements.settingsClearCookie, settings.hasCookie, "Cookie");
    renderCustomHeaders(settings.customHeaders);
}
/**
 * One row per extra header. A stored value is never sent back here, so the row
 * says it exists and leaves the field blank: typing replaces it, leaving it
 * alone keeps it, and removing the row deletes both the header and its file.
 */
function renderCustomHeaders(headers) {
    elements.settingsHeaderList.replaceChildren();
    for (const header of headers)
        addCustomHeaderRow(header.name, header.hasValue);
}
function addCustomHeaderRow(name, hasValue) {
    const row = element("div", "settings-header-row");
    const nameField = document.createElement("input");
    nameField.type = "text";
    nameField.className = "settings-header-name";
    nameField.value = name;
    nameField.maxLength = 63;
    nameField.placeholder = "X-Example";
    nameField.spellcheck = false;
    nameField.setAttribute("aria-label", "请求头名称");
    const valueField = document.createElement("input");
    valueField.type = "password";
    valueField.className = "settings-header-value";
    valueField.maxLength = 4_096;
    valueField.autocomplete = "new-password";
    valueField.spellcheck = false;
    valueField.placeholder = hasValue ? "已配置，留空保留" : "值";
    valueField.dataset["stored"] = hasValue ? "true" : "false";
    valueField.setAttribute("aria-label", "请求头值");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "quiet-text-button";
    remove.textContent = "移除";
    remove.addEventListener("click", () => row.remove());
    row.append(nameField, valueField, remove);
    elements.settingsHeaderList.append(row);
    if (!hasValue)
        nameField.focus();
}
function collectCustomHeaders() {
    const headers = [];
    for (const row of Array.from(elements.settingsHeaderList.querySelectorAll(".settings-header-row"))) {
        const name = row.querySelector(".settings-header-name")?.value.trim() ?? "";
        const field = row.querySelector(".settings-header-value");
        if (!name)
            continue;
        const value = field?.value ?? "";
        // A renamed row has no stored value under its new name, so it must carry one.
        if (value)
            headers.push({ name, value });
        else
            headers.push({ name });
    }
    return headers;
}
/**
 * Secrets stay in files outside `config.json`, so the panel shows exactly where
 * each one is read from. Only the path is ever rendered — never the value.
 */
function populateSettingsPaths(settings) {
    elements.settingsConfigPath.textContent = settings.configPath;
    elements.settingsModelsPath.textContent = settings.modelsPath;
    elements.settingsApiKeyPath.textContent = settings.apiKeyPath;
    elements.settingsCookiePath.textContent = settings.cookiePath;
    elements.settingsApiKeyState.textContent = settings.hasApiKey ? "已配置" : "未配置";
    elements.settingsApiKeyState.dataset["state"] = settings.hasApiKey ? "present" : "absent";
    elements.settingsCookieState.textContent = settings.hasCookie ? "已配置" : "未配置";
    elements.settingsCookieState.dataset["state"] = settings.hasCookie ? "present" : "absent";
}
function bindPathCopy(button, source) {
    button.addEventListener("click", () => {
        const path = source.textContent ?? "";
        if (!path || path === "—")
            return;
        void navigator.clipboard.writeText(path).then(() => flashButtonLabel(button, "已复制"), () => flashButtonLabel(button, "复制失败"));
    });
}
function flashButtonLabel(button, label) {
    const original = button.dataset["label"] ?? button.textContent ?? "";
    button.dataset["label"] = original;
    button.textContent = label;
    nudgeElement(button);
    window.setTimeout(() => {
        button.textContent = button.dataset["label"] ?? original;
    }, 1_400);
}
async function saveSettings() {
    if (savingSettings)
        return;
    const update = {
        provider: elements.settingsProvider.value,
        model: elements.settingsModel.value.trim(),
        baseUrl: elements.settingsBaseUrl.value.trim(),
        api: elements.settingsApi.value,
        thinking: elements.settingsThinking.value,
        customModel: elements.settingsProvider.value === "custom-openai",
        permissionMode: elements.settingsPermissionMode.value,
        autoCompactionEnabled: elements.settingsAutoCompaction.checked,
        autoCompactionTriggerTokens: elements.settingsCompactionTrigger.valueAsNumber,
        autoCompactionReserveTokens: elements.settingsCompactionReserve.valueAsNumber,
        autoCompactionKeepRecentTokens: elements.settingsCompactionKeepRecent.valueAsNumber,
        ...(elements.settingsApiKey.value ? { apiKey: elements.settingsApiKey.value } : {}),
        ...(elements.settingsCookie.value ? { cookie: elements.settingsCookie.value } : {}),
        customHeaders: collectCustomHeaders(),
        clearApiKey: elements.settingsClearKey.checked,
        clearCookie: elements.settingsClearCookie.checked,
    };
    savingSettings = true;
    elements.settingsSave.disabled = true;
    elements.settingsCancel.disabled = true;
    elements.settingsClose.disabled = true;
    elements.settingsStatus.textContent = "正在验证并保存设置…";
    try {
        const result = await window.pspore.saveSettings(update);
        populateSettings(result.settings);
        // Indexing is a separate config section; saving it here keeps one button.
        const indexing = await window.pspore.saveIndexing({
            enabled: elements.settingsIndexingEnabled.checked,
            directories: [...indexingDirectories],
            intervalMinutes: elements.settingsIndexingInterval.valueAsNumber,
            extensions: elements.settingsIndexingExt.value.split(",").map((value) => value.trim()).filter(Boolean),
        });
        populateIndexingSettings(indexing.settings);
        elements.settingsStatus.textContent = `${result.message} ${indexing.message}`;
    }
    catch (error) {
        elements.settingsStatus.textContent = `保存失败：${toError(error).message}`;
    }
    finally {
        savingSettings = false;
        elements.settingsSave.disabled = false;
        elements.settingsCancel.disabled = false;
        elements.settingsClose.disabled = false;
    }
}
const PERMISSION_MODE_HELP = {
    ask_risky: "越界操作会先弹出批准请求。",
    ask_all: "所有写入、执行与外部副作用类工具都会先请求批准。",
    allow_all: "所有工具立即执行，不再产生批准请求。",
    deny: "所有受控工具都会被直接拒绝，只保留纯读取能力。",
};
function configurePermissionFields() {
    const mode = elements.settingsPermissionMode.value;
    elements.settingsPermissionWarning.hidden = mode !== "allow_all";
    elements.settingsPermissionHelp.textContent = PERMISSION_MODE_HELP[mode] ?? PERMISSION_MODE_HELP["ask_risky"] ?? "";
}
function configureProviderFields(resetModel) {
    const provider = elements.settingsProvider.value;
    const custom = provider === "custom-openai";
    if (resetModel)
        elements.settingsModel.value = defaultModelFor(provider);
    elements.settingsBaseUrl.disabled = !custom;
    elements.settingsBaseUrl.required = custom;
    elements.settingsApi.disabled = !custom;
    if (custom) {
        if (elements.settingsApi.value === "provider-default")
            elements.settingsApi.value = "openai-completions";
        elements.settingsProviderHelp.textContent = "使用 OpenAI 兼容接口；必须填写 Base URL，并选择 Chat Completions 或 Responses。";
        elements.settingsBaseUrl.placeholder = "例如 https://gateway.example.com/v1";
    }
    else {
        elements.settingsBaseUrl.value = "";
        elements.settingsApi.value = "provider-default";
        elements.settingsProviderHelp.textContent = provider === "deepseek"
            ? "使用 DeepSeek 内置模型目录与默认接口。"
            : "使用 OpenAI 内置模型目录与默认接口。";
        elements.settingsBaseUrl.placeholder = "选择“自定义 OpenAI”后配置";
    }
}
function closeSettings(restoreFocus = true) {
    if (!settingsOpen || savingSettings)
        return;
    settingsOpen = false;
    elements.settingsApiKey.value = "";
    elements.settingsApiKey.type = "password";
    elements.settingsCookie.value = "";
    elements.settingsCookie.type = "password";
    updateAppInert();
    hideOverlayMotion(elements.settingsOverlay, elements.settingsDialog, () => {
        if (!settingsOpen)
            elements.settingsOverlay.hidden = true;
    });
    if (restoreFocus)
        requestAnimationFrame(() => elements.settingsButton.focus());
}
function updateAppInert() {
    const inert = settingsOpen || !elements.approvalOverlay.hidden;
    elements.appShell.inert = inert;
    if (inert)
        elements.appShell.setAttribute("aria-hidden", "true");
    else
        elements.appShell.removeAttribute("aria-hidden");
}
function trapDialogFocus(event, container) {
    if (event.key !== "Tab")
        return;
    const focusable = Array.from(container.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")).filter((candidate) => candidate.offsetParent !== null);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last)
        return;
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    }
    else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}
async function submitComposer() {
    let text;
    try {
        text = composeMessageWithFileReferences(elements.composerInput.value, composerFileReferences);
    }
    catch (error) {
        store.setNotice(toError(error).message);
        render();
        return;
    }
    if (!text)
        return;
    nudgeElement(elements.send);
    const snapshot = store.snapshot();
    const intent = conversationIntent(snapshot.kernel, snapshot.selectedSessionId, text, "auto");
    let command;
    if (intent.target === "agent") {
        command = {
            action: "agent.send",
            agentId: intent.agentId,
            message: intent.text,
            mode: intent.mode,
        };
    }
    else {
        command = { action: "prompt", text: intent.text, sessionId: intent.sessionId };
    }
    await perform(`发送到 ${intent.target === "agent" ? intent.agentId : shortId(intent.sessionId)}`, command, () => {
        elements.composerInput.value = "";
        composerFileReferences = [];
        renderComposerFileReferences();
        elements.composerInput.focus();
    });
}
async function perform(pendingNotice, command, onSuccess) {
    store.setNotice(`正在${pendingNotice}…`);
    render();
    try {
        const result = await dispatchAcrossReconnect(command);
        store.setNotice(`${pendingNotice}：完成`);
        await onSuccess?.(result);
    }
    catch (error) {
        store.setNotice(`${pendingNotice}失败：${toError(error).message}`);
    }
    render();
}
/**
 * The shell keeps its controls enabled through a short reconnect, so a command
 * issued in that window must not simply fail. Only the "not connected" error is
 * retried: the bridge raises it before writing anything to the socket, so the
 * retry cannot duplicate a command the daemon already ran.
 */
async function dispatchAcrossReconnect(command) {
    try {
        return await window.pspore.dispatch(command);
    }
    catch (error) {
        const message = toError(error).message;
        if (!message.includes(DAEMON_NOT_CONNECTED_MESSAGE) || !store.snapshot().reconnecting)
            throw error;
        store.setNotice("守护进程正在重连，命令将在连接恢复后发送…");
        render();
        if (!(await waitForConnection()))
            throw error;
        return window.pspore.dispatch(command);
    }
}
function waitForConnection() {
    return new Promise((resolve) => {
        const deadline = Date.now() + CONNECTION_SETTLE_MS;
        const poll = () => {
            if (store.snapshot().connection.phase === "connected")
                resolve(true);
            else if (Date.now() >= deadline)
                resolve(false);
            else
                window.setTimeout(poll, 100);
        };
        poll();
    });
}
async function refreshSideData() {
    const snapshot = store.snapshot();
    if (snapshot.stableConnection.phase !== "connected") {
        store.setNotice("守护进程离线；重连后会自动刷新列表");
        render();
        return;
    }
    store.setNotice("正在刷新计划任务与受信资源…");
    render();
    const results = await Promise.allSettled([
        window.pspore.dispatch({ action: "jobs.list" }),
        window.pspore.dispatch({ action: "resources.list" }),
        window.pspore.dispatch({ action: "agents.list" }),
        window.pspore.dispatch({ action: "mcp.servers" }),
        window.pspore.dispatch({ action: "tools.list" }),
        window.pspore.dispatch({ action: "skills.catalog" }),
    ]);
    const toolResult = results[4];
    if (toolResult?.status === "fulfilled" && Array.isArray(toolResult.value)) {
        builtinTools = toolResult.value.filter(isBuiltinTool);
    }
    const skillResult = results[5];
    if (skillResult?.status === "fulfilled" && Array.isArray(skillResult.value)) {
        skillCatalog = skillResult.value.filter(isSkillCatalogEntry);
    }
    const jobResult = results[0];
    const resourceResult = results[1];
    if (jobResult?.status === "fulfilled" && Array.isArray(jobResult.value)) {
        jobs = jobResult.value.filter(isJobDefinition);
    }
    if (resourceResult?.status === "fulfilled" && Array.isArray(resourceResult.value)) {
        resources = resourceResult.value.filter(isResourceEntry);
    }
    const failures = results.filter((result) => result.status === "rejected");
    store.setNotice(failures.length ? `有 ${failures.length} 项列表刷新失败` : "列表已刷新");
    render();
}
function render() {
    const snapshot = store.snapshot();
    renderHeader(snapshot);
    renderSessions(snapshot);
    renderConversation(snapshot);
    renderActivities(snapshot.activities);
    renderRunActivity(snapshot);
    renderIndexing(snapshot);
    renderJobs(snapshot);
    renderIntegrations(snapshot);
    renderNotifications(snapshot);
    renderApproval(snapshot);
    renderInspection();
    renderVersions();
    renderSequence += 1;
    document.documentElement.dataset["renderSequence"] = String(renderSequence);
    document.documentElement.dataset["revision"] = String(snapshot.kernel.revision);
    document.documentElement.dataset["approval"] = Object.keys(snapshot.kernel.approvals).length ? "visible" : "hidden";
    document.documentElement.dataset["connection"] = snapshot.stableConnection.phase;
    document.documentElement.dataset["reconnecting"] = snapshot.reconnecting ? "true" : "false";
}
/**
 * The settle window is time-based, so a run that stays disconnected without
 * emitting further frames still has to surface. One timer, re-armed only while
 * a reconnect is being masked.
 */
function scheduleConnectionSettle(snapshot) {
    if (!snapshot.reconnecting) {
        if (settleTimer !== undefined) {
            window.clearTimeout(settleTimer);
            settleTimer = undefined;
        }
        return;
    }
    if (settleTimer !== undefined)
        return;
    settleTimer = window.setTimeout(() => {
        settleTimer = undefined;
        if (store.settleConnection())
            scheduleRender();
        else
            scheduleConnectionSettle(store.snapshot());
    }, 250);
}
function scheduleRender() {
    if (renderFrame !== undefined)
        return;
    renderFrame = requestAnimationFrame(() => {
        renderFrame = undefined;
        render();
    });
}
function scheduleTranscriptRender() {
    if (transcriptRenderFrame !== undefined)
        return;
    transcriptRenderFrame = requestAnimationFrame(() => {
        transcriptRenderFrame = undefined;
        if (initialized)
            renderConversation(store.snapshot());
    });
}
function handleTranscriptScroll() {
    transcriptState.followTail = isScrollNearEnd(elements.transcript.scrollHeight, elements.transcript.scrollTop, elements.transcript.clientHeight);
    if (elements.transcript.scrollTop < HISTORY_BACKFILL_TRIGGER_PX)
        void loadOlderHistory();
    scheduleTranscriptRender();
}
/**
 * Broadcasts carry only the newest part of a conversation, so scrolling to the
 * top asks the daemon for the page before it. The viewport is pinned to the
 * message the reader was looking at rather than to a scroll offset that the
 * prepended history has just moved.
 */
async function loadOlderHistory() {
    if (transcriptState.loadingHistory)
        return;
    const snapshot = store.snapshot();
    const sessionId = snapshot.selectedSessionId;
    const session = snapshot.kernel.sessions[sessionId];
    if (!session || session.messageOffset === 0)
        return;
    const from = Math.max(0, session.messageOffset - HISTORY_PAGE_SIZE);
    transcriptState.loadingHistory = true;
    try {
        const page = await dispatchAcrossReconnect({
            action: "session.transcript",
            sessionId,
            from,
            limit: session.messageOffset - from,
        });
        if (!isTranscriptPage(page) || page.sessionId !== store.snapshot().selectedSessionId)
            return;
        const anchor = elements.transcript.scrollHeight - elements.transcript.scrollTop;
        if (!store.applyTranscriptPage(page))
            return;
        render();
        elements.transcript.scrollTop = Math.max(0, elements.transcript.scrollHeight - anchor);
    }
    catch {
        // A refused or disconnected backfill simply leaves the history where it is.
    }
    finally {
        transcriptState.loadingHistory = false;
    }
}
function isTranscriptPage(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const page = value;
    return typeof page["sessionId"] === "string"
        && typeof page["from"] === "number"
        && typeof page["count"] === "number"
        && Array.isArray(page["messages"]);
}
function renderHeader(snapshot) {
    // The settled state is what the header shows: a reconnect that finishes inside
    // the settle window stays "ONLINE" so a long run does not strobe the badge.
    const connection = snapshot.stableConnection;
    elements.connectionBadge.className = `connection-badge ${connection.phase}`;
    elements.connectionBadge.dataset["reconnecting"] = snapshot.reconnecting ? "true" : "false";
    elements.connectionBadge.replaceChildren(element("i"), text(connection.phase === "connected" ? "ONLINE" : connection.phase.toUpperCase()));
    if (lastConnectionPhase && connection.phase !== lastConnectionPhase)
        pulseStatus(elements.connectionBadge);
    lastConnectionPhase = connection.phase;
    setReconnectingPulse(elements.connectionBadge, snapshot.reconnecting);
    elements.daemonInstance.textContent = connection.instanceId ? `daemon ${shortId(connection.instanceId)}` : "等待本地守护进程";
    toggleBannerMotion(elements.connectionBanner, connection.phase !== "connected");
    elements.connectionMessage.textContent = friendlyConnectionMessage(connection.message, connection.phase);
    const session = snapshot.kernel.sessions[snapshot.selectedSessionId];
    tweenMetric(elements.revision, snapshot.kernel.revision, String);
    tweenMetric(elements.usage, session?.usage.total ?? 0, formatTokens);
    tweenMetric(elements.cache, (session?.usage.cacheRead ?? 0) + (session?.usage.cacheWrite ?? 0), formatTokens);
    crossfadeText(elements.notice, snapshot.notice);
    elements.refresh.disabled = connection.phase !== "connected";
    scheduleConnectionSettle(snapshot);
}
function renderSessions(snapshot) {
    const sessions = presentSessions(snapshot.kernel, snapshot.selectedSessionId);
    const connected = snapshot.stableConnection.phase === "connected";
    const nodes = sessions.map((session) => sessionRow(session, connected));
    const sessionSignature = sessions
        .map((session) => `${session.id}:${session.status}:${session.selected}:${session.id === armedSessionDeletion}`)
        .join("|");
    elements.sessionList.replaceChildren(...nodes);
    if (sessionSignature !== lastSessionSignature) {
        if (lastSessionSignature)
            revealListItems(nodes, { distance: 6 });
        lastSessionSignature = sessionSignature;
    }
    tweenMetric(elements.sessionCount, sessions.length, String);
    elements.newSession.disabled = snapshot.stableConnection.phase !== "connected";
    const child = selectedAgent(snapshot);
    elements.childControls.hidden = !child;
    elements.joinAgent.disabled = !child || terminalAgentStatus(child.status) || snapshot.stableConnection.phase !== "connected";
    elements.cancelAgent.disabled = !child || terminalAgentStatus(child.status) || snapshot.stableConnection.phase !== "connected";
    const metrics = kernelMetrics(snapshot.kernel);
    elements.railRuns.textContent = `${metrics.activeRuns}/${metrics.runs}`;
    elements.railMcp.textContent = `${metrics.readyMcpServers}/${metrics.mcpServers}`;
    elements.railResources.textContent = `${metrics.activeResources}/${metrics.resources}`;
    elements.railApprovals.textContent = String(metrics.pendingApprovals);
    elements.railApprovals.classList.toggle("attention", metrics.pendingApprovals > 0);
}
/**
 * One row of the session rail: the session button plus its delete control.
 *
 * The delete control cannot live inside the session button — a button may not
 * nest another — so the row wraps both and the control is positioned over the
 * button's trailing edge.
 */
function sessionRow(session, connected) {
    const row = element("div", `session-row${session.id === armedSessionDeletion ? " arming" : ""}`);
    row.append(sessionButton(session.id, session.title, session.status, session.depth, session.selected, session.active, session.createdAt));
    // Child agents belong to their root session and are cancelled, not deleted;
    // a placeholder row for a session the daemon does not hold has nothing to
    // delete either.
    if (session.kind === "main" && session.active) {
        row.append(sessionDeleteButton(session, connected));
    }
    return row;
}
/**
 * Deleting a session destroys its transcript, so the first click only arms the
 * control and the second one confirms. An inline two-step control keeps the
 * confirmation in the rail, where the row being deleted is still visible.
 */
function sessionDeleteButton(session, connected) {
    const armed = session.id === armedSessionDeletion;
    const button = element("button", `session-delete${armed ? " armed" : ""}`);
    button.type = "button";
    button.disabled = !connected;
    button.textContent = armed ? "确认删除" : "✕";
    const label = session.id === "main" ? "main" : shortId(session.id);
    button.title = armed ? `确认删除会话 ${label}（包括聊天记录）` : `删除会话 ${label}`;
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!armed) {
            armSessionDeletion(session.id);
            return;
        }
        disarmSessionDeletion();
        void perform(`删除会话 ${label}`, { action: "session.delete", sessionId: session.id });
    });
    return button;
}
/** Arms one row at a time and disarms it again if the user walks away. */
function armSessionDeletion(id) {
    if (armSessionDeletionTimer !== undefined)
        clearTimeout(armSessionDeletionTimer);
    armedSessionDeletion = id;
    armSessionDeletionTimer = window.setTimeout(() => {
        armedSessionDeletion = undefined;
        armSessionDeletionTimer = undefined;
        render();
    }, SESSION_DELETE_ARM_MS);
    render();
}
function disarmSessionDeletion() {
    if (armSessionDeletionTimer !== undefined)
        clearTimeout(armSessionDeletionTimer);
    armSessionDeletionTimer = undefined;
    armedSessionDeletion = undefined;
}
function sessionButton(id, title, status, depth, selected, active, createdAt) {
    const button = element("button", `session-item ${status}${selected ? " selected" : ""}`);
    button.type = "button";
    button.disabled = !active;
    // The rail draws the agent tree as hyphae branching off main; depth feeds both the indent and the connector.
    button.dataset["depth"] = String(depth);
    button.style.setProperty("--session-depth", String(depth));
    const copy = element("span", "session-copy");
    const strong = element("strong");
    strong.textContent = id === "main" ? "main" : shortId(id);
    const small = element("small");
    small.textContent = title;
    copy.append(strong, small);
    // The creation time sits beside the id, which is what the list is ordered by,
    // so the ordering is legible instead of something the reader has to infer.
    if (createdAt !== undefined) {
        const when = element("time", "session-time");
        when.textContent = listTime(createdAt);
        when.setAttribute("datetime", createdAt);
        strong.append(when);
    }
    const statusMark = element("span", "session-status-mark");
    statusMark.textContent = status;
    button.append(element("i", "node-dot"), copy, statusMark);
    button.addEventListener("click", () => {
        try {
            store.selectSession(id);
            articles.onSessionChanged();
            render();
        }
        catch (error) {
            store.setNotice(toError(error).message);
            render();
        }
    });
    return button;
}
function renderConversation(snapshot) {
    const session = snapshot.kernel.sessions[snapshot.selectedSessionId];
    const child = selectedAgent(snapshot);
    elements.sessionTitle.textContent = child
        ? `${shortId(child.id)} · ${child.objective}`
        : session?.rootSession?.title ?? (snapshot.selectedSessionId === "main" ? "main" : shortId(snapshot.selectedSessionId));
    const status = session?.status ?? (child?.status ?? "idle");
    elements.sessionStatus.textContent = status.toUpperCase();
    elements.sessionStatus.className = `status-chip ${status}`;
    if (lastSessionStatus && status !== lastSessionStatus)
        flipStatusChip(elements.sessionStatus);
    lastSessionStatus = status;
    elements.modelName.textContent = session?.model ? `${session.model.provider}/${session.model.model}` : "未配置模型";
    elements.composerInput.placeholder = `向 ${child?.id ?? shortId(snapshot.selectedSessionId)} 发送消息…`;
    const connected = snapshot.stableConnection.phase === "connected";
    elements.composerInput.disabled = !connected;
    elements.send.disabled = !connected;
    elements.abort.disabled = !connected || (!child && session?.status !== "running");
    elements.compact.disabled = !connected || Boolean(child) || !session;
    renderMessageQueue(snapshot, child ? undefined : session);
    const transcript = elements.transcript;
    const messages = session?.messages ?? [];
    const streaming = snapshot.streamingText[snapshot.selectedSessionId];
    const thinking = snapshot.streamingThinking[snapshot.selectedSessionId];
    const sessionChanged = transcriptState.sessionId !== snapshot.selectedSessionId;
    const offset = session?.messageOffset ?? 0;
    const previousEnd = transcriptState.end;
    if (sessionChanged) {
        if (transcriptState.measureFrame !== undefined)
            cancelAnimationFrame(transcriptState.measureFrame);
        transcriptState.heights = new VirtualHeightIndex(180);
        transcriptState.nodes.clear();
        transcriptState.messageSource = undefined;
        transcriptState.items = [];
        transcriptState.hasStreaming = false;
        transcriptState.followTail = true;
        transcriptState.pinnedIndex = undefined;
        transcriptState.stream = undefined;
    }
    transcriptState.sessionId = snapshot.selectedSessionId;
    transcriptState.end = offset + messages.length;
    if (messages.length === 0 && !streaming && !thinking) {
        transcriptState.heights.sync([]);
        const empty = emptyTranscript(Boolean(child));
        transcript.replaceChildren(empty);
        if (sessionChanged)
            animateTranscriptHero(empty.querySelector(":scope > div"));
        sessionSearch.paint();
        return;
    }
    const hasStreaming = Boolean(streaming || thinking);
    const messagesChanged = transcriptState.messageSource !== messages;
    if (messagesChanged) {
        transcriptState.messageSource = messages;
        // Keyed by absolute transcript position, so prepending older history keeps
        // the keys — and therefore the measured heights — of what is on screen.
        transcriptState.items = messages.map((message, index) => {
            const address = message.id === undefined ? { index: offset + index } : { id: message.id };
            // A message restored in full replaces the cut copy the daemon published.
            const restored = fullMessageTexts.get(fullTextKey(snapshot.selectedSessionId, address));
            const resolved = restored === undefined ? message : { ...message, text: restored };
            return { key: messageVirtualKey(resolved, offset + index), message: resolved, address };
        });
    }
    if (messagesChanged || transcriptState.hasStreaming !== hasStreaming) {
        transcriptState.hasStreaming = hasStreaming;
        transcriptState.heights.sync([
            ...transcriptState.items.map((item) => item.key),
            ...(hasStreaming ? ["$stream"] : []),
        ]);
    }
    const itemCount = transcriptState.items.length + (hasStreaming ? 1 : 0);
    sessionSearch.prepare(sessionChanged);
    const viewportHeight = Math.max(1, transcript.clientHeight);
    // A held selection outranks the tail: scrolling under a drag would keep
    // changing what is selected, which is what made copying mid-reply impossible.
    const shouldPin = transcriptState.followTail && !hasTranscriptSelection();
    const scrollTop = shouldPin
        ? Math.max(0, transcriptState.heights.totalSize() - viewportHeight)
        : transcript.scrollTop;
    // An item holding a selection stays rendered even when the window drifts off
    // it: dropping its element is the one way left to collapse a selection the
    // reader is still dragging.
    const heldIndex = Number(selectedTranscriptNode()?.dataset["virtualIndex"] ?? Number.NaN);
    const range = transcriptState.heights.range(scrollTop, viewportHeight, undefined, Number.isInteger(heldIndex) ? heldIndex : transcriptState.pinnedIndex);
    const content = [sizeSpacer(transcriptState.spacerStart, range.paddingStart)];
    const visibleMessages = [];
    const appeared = [];
    for (let index = range.start; index < range.end; index += 1) {
        const item = transcriptState.items[index];
        const isStreaming = hasStreaming && index === transcriptState.items.length;
        if (!item && !isStreaming)
            continue;
        const key = isStreaming ? "$stream" : item?.key;
        if (!key)
            continue;
        let node;
        if (isStreaming) {
            const stream = transcriptState.stream ?? createStreamingView();
            if (transcriptState.stream !== stream) {
                transcriptState.stream = stream;
                appeared.push(stream.node);
            }
            stream.update(streaming ?? "", thinking ?? "");
            node = stream.node;
        }
        else {
            const before = transcriptState.nodes.get(key);
            node = cachedMessage(key, item?.message ?? { role: "assistant", text: "" }, item?.address ?? { index });
            if (before !== node)
                appeared.push(node);
        }
        node.dataset["virtualKey"] = key;
        node.dataset["virtualIndex"] = String(index);
        node.setAttribute("aria-posinset", String(index + 1));
        node.setAttribute("aria-setsize", String(itemCount));
        visibleMessages.push(node);
        content.push(node);
    }
    content.push(sizeSpacer(transcriptState.spacerEnd, range.paddingEnd));
    // The bubble is kept for the next reply, so it is emptied when this one ends
    // rather than left holding the blocks it last rendered.
    if (!hasStreaming)
        transcriptState.stream?.update("", "");
    transcript.setAttribute("aria-busy", String(hasStreaming));
    reconcileChildren(transcript, content);
    if (sessionChanged) {
        animateMessagesIn(visibleMessages.slice(-14), true);
    }
    else if (transcriptState.end > previousEnd) {
        // Compared at absolute positions: a history backfill grows the list without
        // adding anything new at the tail, and must not replay the entrance. Only
        // nodes built for this render are animated — one already on screen would be
        // faded back in from nothing every time the tail grows.
        const firstAppended = transcriptState.items.length - (transcriptState.end - previousEnd);
        animateMessagesIn(visibleMessages.filter((node) => appeared.includes(node) && Number(node.dataset["virtualIndex"]) >= firstAppended), false);
    }
    if (shouldPin)
        transcript.scrollTo({ top: transcript.scrollHeight, behavior: "auto" });
    scheduleTranscriptMeasurement();
    sessionSearch.paint();
}
function currentSessionTexts(snapshot) {
    const session = snapshot.kernel.sessions[snapshot.selectedSessionId];
    const messages = session?.messages ?? [];
    const offset = session?.messageOffset ?? 0;
    const texts = messages.map((message, index) => {
        const address = message.id === undefined ? { index: offset + index } : { id: message.id };
        return fullMessageTexts.get(fullTextKey(snapshot.selectedSessionId, address)) ?? message.text;
    });
    const streaming = snapshot.streamingText[snapshot.selectedSessionId] ?? "";
    const thinking = snapshot.streamingThinking[snapshot.selectedSessionId] ?? "";
    if (streaming || thinking)
        texts.push(`${thinking}${thinking && streaming ? "\n" : ""}${streaming}`);
    return texts;
}
function cachedMessage(key, message, address) {
    const cached = transcriptState.nodes.get(key);
    if (cached) {
        transcriptState.nodes.delete(key);
        transcriptState.nodes.set(key, cached);
        return cached;
    }
    const node = renderMessage(message, address);
    transcriptState.nodes.set(key, node);
    while (transcriptState.nodes.size > 128) {
        const oldest = transcriptState.nodes.keys().next().value;
        if (oldest === undefined)
            break;
        transcriptState.nodes.delete(oldest);
    }
    return node;
}
function scheduleTranscriptMeasurement() {
    if (transcriptState.measureFrame !== undefined)
        cancelAnimationFrame(transcriptState.measureFrame);
    transcriptState.measureFrame = requestAnimationFrame(() => {
        transcriptState.measureFrame = undefined;
        let changed = false;
        for (const node of Array.from(elements.transcript.querySelectorAll("[data-virtual-key]"))) {
            const key = node.dataset["virtualKey"];
            if (!key)
                continue;
            const margin = Number.parseFloat(getComputedStyle(node).marginBottom) || 0;
            changed = transcriptState.heights.update(key, node.offsetHeight + margin) || changed;
        }
        if (transcriptState.followTail && !hasTranscriptSelection()) {
            elements.transcript.scrollTo({ top: elements.transcript.scrollHeight, behavior: "auto" });
        }
        if (changed)
            scheduleTranscriptRender();
    });
}
/**
 * One padding element per edge, kept for the life of the transcript and resized
 * in place. Recreating them would make every render a structural change, which
 * is what used to detach the messages between them.
 */
function virtualSpacer(edge) {
    const spacer = element("div", `virtual-spacer ${edge}`);
    spacer.style.height = "0px";
    spacer.setAttribute("aria-hidden", "true");
    return spacer;
}
function sizeSpacer(spacer, height) {
    const next = `${Math.max(0, Math.round(height))}px`;
    if (spacer.style.height !== next)
        spacer.style.height = next;
    return spacer;
}
/**
 * True while the reader is holding a selection inside the transcript.
 *
 * Following the tail then would drag the viewport out from under them mid-drag,
 * so the pin stands down until the selection collapses — which a click anywhere
 * does.
 */
function hasTranscriptSelection() {
    return selectedTranscriptNode() !== undefined;
}
/** The rendered message the reader's selection starts in, if it is in the transcript. */
function selectedTranscriptNode() {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0)
        return undefined;
    for (const node of [selection.anchorNode, selection.focusNode]) {
        if (!node || !elements.transcript.contains(node))
            continue;
        const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        const held = element?.closest("[data-virtual-index]");
        if (held)
            return held;
    }
    return undefined;
}
function messageVirtualKey(message, index) {
    return `${index}:${message.role}:${message.text.length}:${textFingerprint(message.text)}`;
}
function textFingerprint(value) {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
    }
    return (hash >>> 0).toString(36);
}
function renderMessageQueue(snapshot, session) {
    const direct = session?.queue.steering ?? [];
    const queued = session?.queue.followUp ?? [];
    elements.messageQueue.hidden = direct.length + queued.length === 0;
    if (direct.length + queued.length === 0) {
        elements.messageQueue.replaceChildren();
        return;
    }
    const directNodes = direct.map((message) => {
        const row = element("article", "queue-message direct");
        row.dataset["queueMode"] = "direct";
        const state = element("span");
        state.textContent = "直接发送消息";
        state.title = "等待当前工具步骤结束后发送";
        const copy = element("p");
        copy.textContent = message;
        copy.title = message;
        row.append(state, copy);
        return row;
    });
    const queuedNodes = queued.map((message, index) => {
        const row = element("article", "queue-message");
        row.dataset["queueMode"] = "follow-up";
        const state = element("span");
        state.textContent = "继续排队";
        const copy = element("p");
        copy.textContent = message;
        copy.title = message;
        const sendNow = actionButton("直接发送消息", "ghost-button", () => {
            void perform("直接发送消息", {
                action: "queue.send-now",
                sessionId: snapshot.selectedSessionId,
                index,
            });
        });
        sendNow.disabled = snapshot.stableConnection.phase !== "connected";
        row.append(state, copy, sendNow);
        return row;
    });
    elements.messageQueue.replaceChildren(...directNodes, ...queuedNodes);
}
/**
 * What a first conversation should look like: each one runs real tools, comes
 * back in seconds, and needs no approval under the default policy. The first
 * ends in the document panel, because a written deliverable is the part of this
 * app nothing else on the screen explains.
 */
const MAIN_SESSION_EXAMPLES = [
    {
        label: "把这台机器的 CPU、内存、磁盘和系统版本整理成一份可导出的说明文档",
        prompt: "把这台机器的 CPU、内存、磁盘和系统版本整理成一份可导出的说明文档",
    },
    {
        label: "看看现在最占内存的 10 个进程，说说哪些可以关掉",
        prompt: "看看现在最占内存的 10 个进程，说说哪些可以关掉",
    },
    {
        // A template rather than a prompt. Clicking it also attaches the desktop,
        // so the reference a dropped folder produces is already on screen: the way
        // to point this agent at a directory is visible before it is explained.
        label: "分析一个目录里都有什么 —— 已附上桌面，也可以拖入别的文件夹",
        prompt: "分析这个目录里都有什么、哪些可以清理，把结论整理成文档：",
        attach: "desktop",
    },
];
function emptyTranscript(isChild) {
    const empty = element("div", "empty-transcript");
    const inner = element("div");
    const heading = element("strong");
    heading.textContent = isChild ? "子 Agent 尚未产生消息" : "在这台机器上开始一件事";
    const body = element("span");
    body.textContent = isChild
        ? "可以继续发送消息推进它；运行中发送的内容会自动排队。"
        : "pSpore 在本地运行：读写文件、执行命令、安排定时任务；越界操作会先向你请求批准。";
    inner.append(heading, body);
    if (!isChild) {
        const suggestions = element("div", "transcript-suggestions");
        for (const example of MAIN_SESSION_EXAMPLES) {
            suggestions.append(actionButton(example.label, "", () => {
                elements.composerInput.value = example.prompt;
                if (example.attach === "desktop" && desktopPlaces?.desktop) {
                    const reference = composerFileReference(desktopPlaces.desktop, "directory");
                    if (reference)
                        addComposerFileReferences([reference]);
                }
                elements.composerInput.focus();
                // Leaves the caret at the end, where a dropped path is appended.
                elements.composerInput.setSelectionRange(example.prompt.length, example.prompt.length);
            }));
        }
        inner.append(suggestions);
    }
    empty.append(inner);
    return empty;
}
function renderMessage(message, address) {
    const role = normalizedRole(message.role);
    const article = element("article", `message ${role}`);
    const meta = element("div", "message-meta");
    const label = element("span");
    label.textContent = role === "assistant" ? "pSpore" : role;
    meta.append(element("i", "role-dot"), label);
    if (role === "tool") {
        const receipt = parseArticleReceipt(message.text);
        if (receipt) {
            const card = element("div", "article-receipt");
            const heading = element("strong");
            heading.textContent = receipt.title ? `文稿 · ${receipt.title}` : "文稿";
            const version = element("span");
            version.textContent = `第 ${receipt.version} 版`;
            const open = document.createElement("button");
            open.className = "ghost-button";
            open.type = "button";
            open.textContent = "打开文稿";
            open.addEventListener("click", () => {
                void articles.open(receipt.id, receipt.version);
            });
            card.append(heading, version, open);
            article.append(meta, card);
            return article;
        }
        const details = element("details");
        const summary = element("summary");
        summary.textContent = `工具输出 · ${formatBytes(new TextEncoder().encode(message.text).byteLength)} · 点击展开`;
        const pre = element("pre");
        pre.textContent = message.text || "（无输出）";
        details.append(summary, pre);
        article.append(meta, details);
    }
    else if (role === "assistant" && message.text.trim() === "") {
        // A turn that only called a tool has no words of its own. The tool card
        // below already says what happened, so the empty shell is collapsed rather
        // than announced — with the article tool this is every writing turn.
        article.classList.add("message-silent");
        article.append(meta);
    }
    else {
        const body = element("div", "message-body markdown");
        appendMarkdown(body, message.text || "（空消息）");
        article.append(meta, body);
    }
    const truncation = publishedTextTruncation(message.text);
    if (truncation)
        article.append(truncationNotice(address, truncation));
    return article;
}
/**
 * Offers the rest of a message the daemon had to cut. The publishing ceiling
 * keeps one enormous message from crowding out everything else on the wire, so
 * the full text is something a reader asks for rather than something every
 * broadcast carries.
 */
function truncationNotice(address, truncation) {
    const notice = element("div", "message-truncated");
    const summary = element("span");
    summary.textContent = `仅显示前 ${truncation.kept.toLocaleString("zh-CN")} / ${truncation.total.toLocaleString("zh-CN")} 个字符`;
    const button = element("button", "ghost-button");
    button.type = "button";
    button.textContent = "载入全文";
    button.addEventListener("click", () => {
        button.disabled = true;
        button.textContent = "载入中…";
        void loadFullMessage(store.snapshot().selectedSessionId, address).then((loaded) => {
            // A successful load re-renders the message without this notice; a failed
            // one leaves it on screen, so the button has to become usable again.
            if (loaded)
                return;
            button.disabled = false;
            button.textContent = "重试载入全文";
        });
    });
    notice.append(summary, button);
    return notice;
}
/**
 * Pulls one message's untruncated text in slices no larger than the daemon
 * publishes, then re-renders with it in place. Slices rather than one frame,
 * because raising the ceiling for a single message raises it for every one.
 */
async function loadFullMessage(sessionId, address) {
    const key = fullTextKey(sessionId, address);
    if (loadingFullText.has(key) || fullMessageTexts.has(key))
        return false;
    loadingFullText.add(key);
    try {
        const restored = await readFullMessage((offset, limit) => dispatchAcrossReconnect({
            action: "session.message",
            sessionId,
            ...address,
            offset,
            limit,
        }));
        // Slices that do not line up would splice two versions of one message
        // together, so the restore is abandoned rather than shown.
        if (restored === undefined)
            throw new Error("消息内容已变化");
        rememberFullText(key, restored);
        // The message array is unchanged, so the cached items have to be rebuilt
        // for the restored text to reach the screen.
        transcriptState.messageSource = undefined;
        store.setNotice("载入全文：完成");
        return true;
    }
    catch (error) {
        store.setNotice(`载入全文失败：${toError(error).message}`);
        return false;
    }
    finally {
        loadingFullText.delete(key);
        render();
    }
}
function rememberFullText(key, value) {
    fullMessageTexts.set(key, value);
    while (fullMessageTexts.size > FULL_TEXT_CACHE_ENTRIES) {
        const oldest = fullMessageTexts.keys().next().value;
        if (oldest === undefined)
            break;
        fullMessageTexts.delete(oldest);
    }
}
function fullTextKey(sessionId, address) {
    return "id" in address ? `${sessionId}\u0000id:${address.id}` : `${sessionId}\u0000at:${String(address.index)}`;
}
function createStreamingView() {
    const article = element("article", "message assistant streaming");
    const meta = element("div", "message-meta");
    const label = element("span");
    meta.append(element("i", "role-dot"), label);
    const reasoning = element("section", "thinking-stream");
    reasoning.setAttribute("aria-label", "思考过程");
    const heading = element("header");
    const title = element("strong");
    title.textContent = "思考中";
    const hint = element("span");
    hint.textContent = "回复完成后自动隐藏";
    heading.append(title, hint);
    const thinkingBody = element("div", "thinking-stream-body");
    const thinkingText = document.createTextNode("");
    thinkingBody.append(thinkingText);
    reasoning.append(heading, thinkingBody);
    const body = element("div", "message-body markdown");
    const surface = createMarkdownSurface(body);
    const cursor = element("i", "stream-cursor");
    article.append(meta, reasoning, body);
    let labelText = "";
    return {
        node: article,
        update(value, thinking) {
            const nextLabel = value ? "pSpore · streaming" : "pSpore · thinking";
            if (labelText !== nextLabel) {
                label.textContent = nextLabel;
                labelText = nextLabel;
            }
            reasoning.hidden = thinking === "";
            // Written into the same Text node: replacing it would move the selection
            // out from under a reader holding one, and the value only ever grows.
            if (thinkingText.nodeValue !== thinking)
                thinkingText.nodeValue = thinking;
            body.hidden = value === "";
            if (value) {
                surface.update(value, cursor);
            }
            else {
                surface.update("");
                if (thinking)
                    thinkingBody.append(cursor);
                else
                    cursor.remove();
            }
        },
    };
}
function renderActivities(activities) {
    tweenMetric(elements.activityCount, activities.length, String);
    const cards = activities.slice(-12).reverse().map((activity) => {
        const card = element("article", "activity-card");
        card.dataset["status"] = activity.status;
        const header = element("header");
        const title = element("b");
        const state = element("span", `state-dot ${activity.status}`);
        state.setAttribute("aria-label", activity.status);
        title.append(state, text(activity.label));
        const time = element("time");
        time.textContent = clockTime(activity.ts);
        time.dateTime = activity.ts;
        header.append(title, time);
        card.append(header);
        const summary = element("p");
        summary.textContent = `${activity.summary}${activity.resultSummary ? ` · ${activity.resultSummary}` : ""}${activity.sessionId ? ` · 会话 ${shortId(activity.sessionId)}` : ""}`;
        card.append(summary);
        if (activity.detail) {
            const details = element("details");
            const summary = element("summary");
            summary.textContent = "查看已折叠详情";
            const pre = element("pre", "activity-detail");
            pre.textContent = activity.detail;
            details.append(summary, pre);
            card.append(details);
        }
        return card;
    });
    elements.activityList.replaceChildren(...(cards.length ? cards : [emptyList("暂无活动事件")]));
    // The inspector re-renders on every frame; only animate when the set changed,
    // otherwise a streaming run would restart the stagger dozens of times a second.
    const signature = activities.slice(-12).map((activity) => `${activity.id}:${activity.status}`).join("|");
    if (signature !== lastActivitySignature) {
        if (lastActivitySignature && cards.length)
            revealListItems(cards, { distance: 6, maxStagger: 8 });
        lastActivitySignature = signature;
    }
}
/**
 * What the agent is doing right now, so a run that produces no text for a while
 * is visibly working rather than indistinguishable from a hang.
 *
 * The phases are separated because they fail differently: a tool that never
 * returns is a stuck command, a model that never answers is a stalled request,
 * and an unanswered approval is waiting on the reader. Each gets its own mark
 * and its own elapsed clock.
 */
function renderRunActivity(snapshot) {
    const phase = currentRunPhase(snapshot);
    if (!phase) {
        activityPhase = undefined;
        stopActivityTicker();
        elements.runActivity.hidden = true;
        return;
    }
    if (activityPhase?.key !== phase.key)
        activityPhase = { key: phase.key, since: Date.now() };
    elements.runActivity.hidden = false;
    elements.runActivity.dataset["phase"] = phase.kind;
    elements.runActivityMark.dataset["phase"] = phase.kind;
    elements.runActivityLabel.textContent = phase.label;
    const seconds = Math.floor((Date.now() - (activityPhase?.since ?? Date.now())) / 1000);
    // Silence for a second or two is normal; a count that only appears after that
    // keeps the line calm while still answering "how long" when it matters.
    elements.runActivityElapsed.textContent = seconds >= 2 ? `已 ${formatElapsed(seconds)}` : "";
    startActivityTicker();
}
function currentRunPhase(snapshot) {
    const sessionId = snapshot.selectedSessionId;
    // An approval blocks the run until the reader acts, so it outranks everything
    // else: nothing will move until it is answered.
    const approval = Object.values(snapshot.kernel.approvals)
        .find((request) => request.sessionId === sessionId);
    if (approval) {
        return { key: `approval:${approval.id}`, kind: "approval", label: `等待你批准 ${approval.capability}` };
    }
    const session = snapshot.kernel.sessions[sessionId];
    const child = selectedAgent(snapshot);
    const running = (session?.status ?? child?.status) === "running";
    if (!running)
        return undefined;
    const tool = snapshot.activities
        .filter((activity) => activity.status === "running" && (activity.sessionId ?? sessionId) === sessionId)
        .at(-1);
    if (tool) {
        const label = tool.toolName === "article" ? "撰写文稿" : `执行 ${tool.toolName ?? tool.label}`;
        return { key: `tool:${tool.id}`, kind: "tool", label };
    }
    if (articles.isWriting())
        return { key: `article:${articles.writingKey()}`, kind: "tool", label: "撰写文稿" };
    if (snapshot.streamingText[sessionId])
        return { key: `stream:${sessionId}`, kind: "streaming", label: "生成回复中" };
    if (snapshot.streamingThinking[sessionId])
        return { key: `think:${sessionId}`, kind: "thinking", label: "思考中" };
    return { key: `wait:${sessionId}`, kind: "waiting", label: "等待模型响应" };
}
/** The elapsed count has to advance without new frames, so it drives itself. */
function startActivityTicker() {
    if (activityTicker !== undefined)
        return;
    activityTicker = window.setInterval(() => {
        if (elements.runActivity.hidden || !activityPhase) {
            stopActivityTicker();
            return;
        }
        const seconds = Math.floor((Date.now() - activityPhase.since) / 1000);
        elements.runActivityElapsed.textContent = seconds >= 2 ? `已 ${formatElapsed(seconds)}` : "";
    }, 1_000);
}
function stopActivityTicker() {
    if (activityTicker === undefined)
        return;
    window.clearInterval(activityTicker);
    activityTicker = undefined;
}
/**
 * Continuous indexing status. The daemon owns the work; this is a read-only
 * view so the user can tell whether a search is running against a current index.
 */
function renderIndexing(snapshot) {
    const view = presentIndexing(snapshot.kernel.indexing, Date.now());
    elements.indexingPanel.dataset["phase"] = view.phase;
    elements.indexingPanel.dataset["progress"] = view.percent === undefined ? "indeterminate" : "determinate";
    elements.indexingPhase.textContent = view.phaseLabel;
    const bar = elements.indexingBarFill.parentElement;
    if (view.percent === undefined) {
        // An indeterminate bar has no value; the stylesheet animates the fill instead.
        elements.indexingBarFill.style.width = "";
        bar?.removeAttribute("aria-valuenow");
    }
    else {
        elements.indexingBarFill.style.width = `${view.percent}%`;
        bar?.setAttribute("aria-valuenow", String(view.percent));
    }
    elements.indexingCounts.textContent = view.counts;
    elements.indexingCurrent.textContent = view.current;
    elements.indexingNote.textContent = view.note;
    if (view.ticking)
        startIndexingTicker();
    else
        stopIndexingTicker();
}
/** A walk that reports nothing still has to show the clock moving. */
function startIndexingTicker() {
    if (indexingTicker !== undefined)
        return;
    indexingTicker = window.setInterval(() => renderIndexing(store.snapshot()), 1_000);
}
function stopIndexingTicker() {
    if (indexingTicker === undefined)
        return;
    window.clearInterval(indexingTicker);
    indexingTicker = undefined;
}
function renderJobs(snapshot) {
    const connected = snapshot.stableConnection.phase === "connected";
    const jobNodes = jobs.slice(0, 4).map((job) => {
        const item = denseItem(job.id, job.enabled ? `${job.schedule.cron} · ${job.schedule.timezone}` : "disabled", job.enabled ? "ready" : "disabled");
        const actions = element("div", "item-actions");
        const run = actionButton("立即运行", "ghost-button", () => void perform(`运行 ${job.id}`, { action: "job.run", jobId: job.id }));
        run.disabled = !connected || !job.enabled;
        actions.append(run);
        item.append(actions);
        return item;
    });
    elements.jobList.replaceChildren(...(jobNodes.length ? jobNodes : [emptyList("没有已加载的 cron job")]));
    const runs = Object.values(snapshot.kernel.runs)
        .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
        .slice(0, 5);
    const runNodes = runs.map((run) => {
        const item = denseItem(run.jobId ?? shortId(run.id), `${run.status} · ${clockTime(run.receivedAt)}`, run.status);
        if (run.status === "queued" || run.status === "running") {
            const actions = element("div", "item-actions");
            const cancel = actionButton("取消运行", "danger-ghost-button", () => void perform(`取消运行 ${run.id}`, { action: "run.cancel", runId: run.id }));
            cancel.disabled = !connected;
            actions.append(cancel);
            item.append(actions);
        }
        return item;
    });
    elements.runList.replaceChildren(...(runNodes.length ? runNodes : [emptyList("暂无运行记录")]));
}
function isBuiltinTool(value) {
    return typeof value === "object" && value !== null && typeof value.name === "string";
}
function renderIntegrations(snapshot) {
    const connected = snapshot.stableConnection.phase === "connected";
    const nodes = [];
    // The fixed tools come first: they are what the agent can always do, and
    // without them the panel only ever answered "what has been added".
    if (builtinTools.length > 0) {
        const tools = element("div", "tool-chips");
        tools.setAttribute("role", "list");
        for (const tool of builtinTools) {
            const chip = element("span", "tool-chip");
            chip.setAttribute("role", "listitem");
            chip.textContent = tool.name;
            if (tool.description)
                chip.title = `${tool.label ?? tool.name} — ${tool.description}`;
            tools.append(chip);
        }
        const item = denseItem(`内置工具 · ${builtinTools.length}`, "每个会话都具备", "ready");
        item.append(tools);
        nodes.push(item);
    }
    // Skills next, from every source a session loads them from — not only the
    // trusted installs below — so a skill the user dropped into the workspace is
    // either visible here or listed with the reason it was not loaded.
    const activeSkills = skillCatalog.filter((skill) => skill.status === "active");
    if (activeSkills.length > 0) {
        const chips = element("div", "tool-chips skill-chips");
        chips.setAttribute("role", "list");
        for (const skill of activeSkills) {
            const chip = element("span", "tool-chip");
            chip.setAttribute("role", "listitem");
            chip.textContent = skill.name;
            chip.title = [`${skill.name} · ${SKILL_SOURCE_LABELS[skill.source]}`, skill.description, skill.path, skill.message]
                .filter(Boolean)
                .join("\n");
            chips.append(chip);
        }
        const item = denseItem(`Skills · ${activeSkills.length}`, "新会话可用", "ready");
        item.append(chips);
        nodes.push(item);
    }
    for (const skill of skillCatalog.filter((candidate) => candidate.status !== "active")) {
        const item = denseItem(`未加载 Skill · ${skill.name}`, `${SKILL_SOURCE_LABELS[skill.source]} · ${skill.status === "shadowed" ? "同名被覆盖" : "已跳过"}`, "degraded");
        const reason = element("p");
        reason.textContent = skill.message ? `${skill.message}（${skill.path}）` : skill.path;
        item.append(reason);
        nodes.push(item);
    }
    for (const health of Object.values(snapshot.kernel.mcpServers)) {
        const item = denseItem(`MCP · ${health.serverId}`, `${health.status} · ${health.toolCount} tools`, health.status);
        const actions = element("div", "item-actions");
        const discover = actionButton("发现工具", "ghost-button", () => void perform(`发现 ${health.serverId} 工具`, { action: "mcp.discover", serverId: health.serverId }));
        const ping = actionButton("Ping", "ghost-button", () => void perform(`Ping ${health.serverId}`, { action: "mcp.ping", serverId: health.serverId }));
        discover.disabled = !connected || health.status === "disabled" || health.status === "untrusted";
        ping.disabled = discover.disabled;
        actions.append(discover, ping);
        item.append(actions);
        nodes.push(item);
    }
    const catalogByKey = new Map(resources.map((entry) => [`${entry.record.kind}:${entry.record.name}`, entry]));
    for (const health of Object.values(snapshot.kernel.resources)) {
        const item = denseItem(`${health.kind === "skill" ? "Skill" : "Plugin"} · ${health.name}`, `${health.status}${health.restartRequired ? " · restart required" : ""}`, health.status);
        const catalog = catalogByKey.get(`${health.kind}:${health.name}`);
        if (catalog?.record.trusted) {
            const actions = element("div", "item-actions");
            const disable = actionButton("撤销信任", "danger-ghost-button", () => void perform(`撤销 ${health.name} 信任`, {
                action: "resources.disable",
                kind: health.kind,
                name: health.name,
                expectedDigest: health.digest,
            }, refreshSideData));
            disable.disabled = !connected;
            actions.append(disable);
            item.append(actions);
        }
        nodes.push(item);
    }
    elements.integrationList.replaceChildren(...(nodes.length ? nodes : [emptyList("未配置 MCP 或受信资源")]));
}
function renderNotifications(snapshot) {
    const nodes = snapshot.kernel.notifications.slice(-5).reverse().map((notification) => {
        const item = denseItem(notification.title, clockTime(notification.ts), notification.level === "error" ? "failed" : notification.level === "warning" ? "running" : "ready");
        const body = element("p");
        body.textContent = notification.body;
        item.append(body);
        return item;
    });
    elements.notificationList.replaceChildren(...(nodes.length ? nodes : [emptyList("暂无通知")]));
}
function renderApproval(snapshot) {
    const request = Object.values(snapshot.kernel.approvals).sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))[0];
    if (!request) {
        const previousApproval = activeApprovalId;
        activeApprovalId = undefined;
        if (elements.approvalOverlay.hidden)
            return;
        updateAppInert();
        const finishHide = () => {
            if (activeApprovalId !== undefined)
                return;
            elements.approvalOverlay.hidden = true;
            updateAppInert();
            requestAnimationFrame(() => elements.composerInput.focus());
        };
        if (previousApproval)
            hideOverlayMotion(elements.approvalOverlay, elements.approvalDialog, finishHide);
        else
            elements.approvalOverlay.hidden = true;
        return;
    }
    if (settingsOpen && !savingSettings)
        closeSettings(false);
    const firstPaint = elements.approvalOverlay.hidden || activeApprovalId !== request.id;
    elements.approvalOverlay.hidden = false;
    updateAppInert();
    elements.approvalTitle.textContent = request.display.summary;
    elements.approvalSummary.textContent = `Agent ${request.agentPath.join(" → ")} 请求执行受保护操作。批准范围会被守护进程记录并强制执行。`;
    elements.approvalCapability.textContent = request.capability;
    elements.approvalTarget.textContent = request.canonicalTarget ?? request.display.cwd ?? "未指定";
    elements.approvalReasons.textContent = request.riskReasons.join("；") || "策略要求确认";
    elements.approvalCommand.hidden = !request.display.command;
    elements.approvalCommand.textContent = request.display.command ?? "";
    // The buttons are rebuilt only for a different request. Replacing them on every
    // render destroys whichever one holds focus, which silently moved focus back to
    // the document whenever anything else re-rendered while the modal was open.
    if (activeApprovalId !== request.id) {
        const actions = [];
        const denialScope = request.allowedScopes[0] ?? "once";
        actions.push(approvalButton("拒绝", "danger-ghost-button", request, false, denialScope));
        for (const scope of request.allowedScopes) {
            const label = scope === "once" ? "仅此一次" : scope === "session" ? "本会话允许" : "此任务允许";
            actions.push(approvalButton(label, scope === "once" ? "primary-button" : "secondary-button", request, true, scope));
        }
        elements.approvalActions.replaceChildren(...actions);
        activeApprovalId = request.id;
        if (firstPaint)
            showOverlayMotion(elements.approvalOverlay, elements.approvalDialog);
        requestAnimationFrame(() => actions[0]?.focus());
    }
}
function approvalButton(label, className, request, approved, scope) {
    return actionButton(label, className, () => void perform(`${approved ? "批准" : "拒绝"} ${request.id}`, {
        action: "approval.resolve",
        approvalId: request.id,
        approved,
        scope,
    }));
}
function renderInspection() {
    const result = inspection;
    elements.inspectionResult.hidden = !result;
    if (!result) {
        elements.inspectionResult.replaceChildren();
        return;
    }
    const title = element("b");
    title.textContent = `${result.kind} · ${result.name}@${result.resourceVersion}`;
    const digest = element("code");
    digest.textContent = result.digest;
    const summary = element("p");
    summary.textContent = `${result.files.length} 个文件 · ${formatBytes(result.totalBytes)}${result.diagnostics.length ? ` · ${result.diagnostics.join("；")}` : ""}`;
    const install = actionButton(result.installable ? "信任并安装精确内容" : "不可安装", "secondary-button", () => {
        const stagingName = elements.stagingName.value.trim();
        if (stagingName)
            void perform(`安装 ${result.name}`, { action: "resources.install", stagingName, expectedDigest: result.digest }, async () => {
                inspection = undefined;
                await refreshSideData();
            });
    });
    install.disabled = !result.installable || store.snapshot().stableConnection.phase !== "connected";
    elements.inspectionResult.replaceChildren(title, digest, summary, install);
}
function renderVersions() {
    if (!versions)
        return;
    elements.versionLine.textContent = `pSpore ${versions.pspore} · Pi ${versions.pi}`;
    elements.runtimeLine.textContent = `Electron ${versions.electron} · Node ${versions.node}`;
}
function selectedAgent(snapshot) {
    return findSelectedAgent(snapshot.kernel, snapshot.selectedSessionId);
}
function denseItem(titleValue, subtitleValue, status) {
    const item = element("article", "dense-item");
    const header = element("header");
    const title = element("b");
    const dot = element("i", `state-dot ${safeStatus(status)}`);
    title.append(dot, text(titleValue));
    const small = element("small");
    small.textContent = subtitleValue;
    header.append(title, small);
    item.append(header);
    return item;
}
function actionButton(label, className, listener) {
    const button = element("button", className);
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", listener);
    return button;
}
function emptyList(label) {
    const empty = element("div", "empty-list");
    empty.textContent = label;
    return empty;
}
function element(tag, className) {
    const result = document.createElement(tag);
    if (className)
        result.className = className;
    return result;
}
function text(value) {
    return document.createTextNode(value);
}
function byId(id) {
    const value = document.getElementById(id);
    if (!value)
        throw new Error(`Missing desktop element #${id}`);
    return value;
}
function bindSecretField(input, reveal, clear) {
    reveal.addEventListener("click", () => {
        const revealing = input.type === "password";
        input.type = revealing ? "text" : "password";
        reveal.textContent = revealing ? "隐藏" : "显示";
    });
    input.addEventListener("input", () => {
        if (input.value)
            clear.checked = false;
    });
    clear.addEventListener("change", () => {
        if (clear.checked)
            input.value = "";
    });
}
function resetSecretField(input, reveal, clear, configured, label) {
    input.value = "";
    input.type = "password";
    input.placeholder = configured ? "已配置；留空将保留" : `输入 ${label}`;
    reveal.textContent = "显示";
    clear.checked = false;
}
function settingsStatus(settings) {
    const key = settings.hasApiKey ? "已检测到私有 Key" : "尚未保存 API Key";
    const cookie = settings.hasCookie ? "已检测到 Cookie" : "尚未保存 Cookie";
    return `${key}；${cookie}。留空会保留当前值。`;
}
function missingElement(selector) {
    throw new Error(`Missing desktop element ${selector}`);
}
function normalizedRole(role) {
    const normalized = role.toLowerCase();
    if (normalized.includes("tool"))
        return "tool";
    return normalized === "user" ? "user" : "assistant";
}
function safeStatus(value) {
    const allowed = new Set(["ready", "active", "succeeded", "running", "connecting", "starting", "failed", "degraded", "blocked"]);
    return allowed.has(value) ? value : "unknown";
}
function initialTheme() {
    try {
        const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
        if (stored === "dark" || stored === "light")
            return stored;
    }
    catch {
        // Fall through to the daylight default.
    }
    // The product default is the daylight (white & cobalt) theme.
    return "light";
}
function applyTheme(theme) {
    document.documentElement.dataset["theme"] = theme;
    const nextLabel = theme === "dark" ? "切换到浅色模式" : "切换到深色模式";
    elements.themeToggle.setAttribute("aria-label", nextLabel);
    elements.themeToggle.title = nextLabel;
    elements.themeColor.content = theme === "dark" ? "#0c121b" : "#f4f7fb";
}
function friendlyConnectionMessage(message, phase) {
    if (message?.includes("ENOENT") || message?.includes("daemon.sock")) {
        return "本地守护进程正在启动，连接就绪后会自动恢复…";
    }
    return message ?? (phase === "connecting" ? "正在连接本地守护进程…" : "守护进程已断开，正在重试…");
}
function isJobDefinition(value) {
    if (!isRecord(value) || value["version"] !== 1 || typeof value["id"] !== "string" || typeof value["enabled"] !== "boolean")
        return false;
    const schedule = value["schedule"];
    return isRecord(schedule) && typeof schedule["cron"] === "string" && typeof schedule["timezone"] === "string";
}
function isResourceEntry(value) {
    if (!isRecord(value) || !isRecord(value["record"]) || !isRecord(value["health"]))
        return false;
    return typeof value["record"]["name"] === "string" && typeof value["record"]["digest"] === "string";
}
function isSkillCatalogEntry(value) {
    return isRecord(value)
        && typeof value["name"] === "string"
        && typeof value["path"] === "string"
        && (value["source"] === "installed" || value["source"] === "bundled" || value["source"] === "workspace")
        && (value["status"] === "active" || value["status"] === "skipped" || value["status"] === "shadowed");
}
function isInspection(value) {
    return isRecord(value) && value["version"] === 1 && typeof value["name"] === "string" && typeof value["digest"] === "string" && Array.isArray(value["files"]);
}
function isSessionView(value) {
    return isRecord(value)
        && typeof value["sessionId"] === "string"
        && typeof value["upstreamSessionId"] === "string"
        && Array.isArray(value["messages"]);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
//# sourceMappingURL=renderer.js.map