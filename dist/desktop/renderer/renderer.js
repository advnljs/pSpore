/// <reference lib="DOM" />
import { defaultModelFor } from "../../settings/llm-settings.js";
import { clockTime, conversationIntent, formatBytes, formatTokens, kernelMetrics, presentSessions, selectedAgent as findSelectedAgent, shortId, terminalAgentStatus, } from "../../ui/shared/presentation.js";
import { isScrollNearEnd, VirtualHeightIndex } from "../../ui/shared/virtual-list.js";
import { appendMarkdown, appendMarkdownWithTrailing } from "./markdown-view.js";
import { animateMessagesIn, animateTranscriptHero, hideOverlayMotion, introChoreography, nudgeElement, pulseStatus, showOverlayMotion, } from "./motion.js";
import { DesktopStore } from "./store.js";
const store = new DesktopStore();
const queuedFrames = [];
let initialized = false;
let versions;
let jobs = [];
let resources = [];
let inspection;
let activeApprovalId;
let renderSequence = 0;
let settingsOpen = false;
let savingSettings = false;
let responsiveMode;
let introPlayed = false;
let lastConnectionPhase = "";
let renderFrame;
let transcriptRenderFrame;
const transcriptState = {
    sessionId: "",
    count: -1,
    heights: new VirtualHeightIndex(180),
    nodes: new Map(),
    measureFrame: undefined,
    messageSource: undefined,
    items: [],
    hasStreaming: false,
    followTail: true,
};
const THEME_STORAGE_KEY = "pspore.desktop.theme";
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
    sessionStatus: byId("session-status"),
    modelName: byId("model-name"),
    transcript: byId("transcript"),
    notice: byId("notice-line"),
    messageQueue: byId("message-queue"),
    composerForm: byId("composer-form"),
    composerInput: byId("composer-input"),
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
    settingsCompactionReserve: byId("settings-compaction-reserve"),
    settingsCompactionKeepRecent: byId("settings-compaction-keep-recent"),
    settingsApiKey: byId("settings-api-key"),
    settingsKeyReveal: byId("settings-key-reveal"),
    settingsClearKey: byId("settings-clear-key"),
    settingsCookie: byId("settings-cookie"),
    settingsCookieReveal: byId("settings-cookie-reveal"),
    settingsClearCookie: byId("settings-clear-cookie"),
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
applyTheme(initialTheme());
syncResponsivePanels(true);
const unsubscribe = window.pspore.subscribe((frame) => {
    if (!initialized)
        queuedFrames.push(frame);
    else {
        store.applyFrame(frame);
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
        store.applyBootstrap(bootstrap);
        initialized = true;
        for (const frame of queuedFrames.splice(0))
            store.applyFrame(frame);
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
        setPanelState("inspector", document.documentElement.dataset["inspector"] !== "open");
    });
    elements.inspectorClose.addEventListener("click", () => setPanelState("inspector", false));
    for (const tab of elements.inspectorTabs) {
        tab.addEventListener("click", () => selectInspectorTab(tab.dataset["inspectorTab"]));
    }
    elements.agentComposeToggle.addEventListener("click", () => setAgentCompose(elements.agentCompose.hidden));
    elements.agentComposeClose.addEventListener("click", () => setAgentCompose(false));
    elements.resourceShortcut.addEventListener("click", () => {
        selectInspectorTab("resources");
        setPanelState("inspector", true);
    });
    window.addEventListener("resize", () => syncResponsivePanels(false));
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
            if (!isAgentSnapshot(result))
                throw new Error("服务返回了无效的会话");
            store.selectSession(result.sessionId);
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
    for (const view of elements.inspectorViews)
        view.hidden = view.dataset["inspectorPanel"] !== selected;
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
        const settings = await window.pspore.getSettings();
        populateSettings(settings);
        elements.settingsStatus.textContent = settingsStatus(settings);
        elements.settingsSave.disabled = false;
    }
    catch (error) {
        elements.settingsStatus.textContent = `读取失败：${toError(error).message}`;
    }
}
function populateSettings(settings) {
    elements.settingsProvider.value = settings.provider;
    elements.settingsModel.value = settings.model;
    elements.settingsBaseUrl.value = settings.baseUrl;
    elements.settingsApi.value = settings.api;
    elements.settingsThinking.value = settings.thinking;
    elements.settingsPermissionMode.value = settings.permissionMode;
    elements.settingsAutoCompaction.checked = settings.autoCompactionEnabled;
    elements.settingsCompactionReserve.value = String(settings.autoCompactionReserveTokens);
    elements.settingsCompactionKeepRecent.value = String(settings.autoCompactionKeepRecentTokens);
    configurePermissionFields();
    configureProviderFields(false);
    resetSecretField(elements.settingsApiKey, elements.settingsKeyReveal, elements.settingsClearKey, settings.hasApiKey, "API Key");
    resetSecretField(elements.settingsCookie, elements.settingsCookieReveal, elements.settingsClearCookie, settings.hasCookie, "Cookie");
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
        autoCompactionReserveTokens: elements.settingsCompactionReserve.valueAsNumber,
        autoCompactionKeepRecentTokens: elements.settingsCompactionKeepRecent.valueAsNumber,
        ...(elements.settingsApiKey.value ? { apiKey: elements.settingsApiKey.value } : {}),
        ...(elements.settingsCookie.value ? { cookie: elements.settingsCookie.value } : {}),
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
        elements.settingsStatus.textContent = result.message;
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
    const text = elements.composerInput.value.trim();
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
        elements.composerInput.focus();
    });
}
async function perform(pendingNotice, command, onSuccess) {
    store.setNotice(`正在${pendingNotice}…`);
    render();
    try {
        const result = await window.pspore.dispatch(command);
        store.setNotice(`${pendingNotice}：完成`);
        await onSuccess?.(result);
    }
    catch (error) {
        store.setNotice(`${pendingNotice}失败：${toError(error).message}`);
    }
    render();
}
async function refreshSideData() {
    const snapshot = store.snapshot();
    if (snapshot.connection.phase !== "connected") {
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
    ]);
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
    document.documentElement.dataset["connection"] = snapshot.connection.phase;
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
    scheduleTranscriptRender();
}
function renderHeader(snapshot) {
    const connection = snapshot.connection;
    elements.connectionBadge.className = `connection-badge ${connection.phase}`;
    elements.connectionBadge.replaceChildren(element("i"), text(connection.phase === "connected" ? "ONLINE" : connection.phase.toUpperCase()));
    if (lastConnectionPhase && connection.phase !== lastConnectionPhase)
        pulseStatus(elements.connectionBadge);
    lastConnectionPhase = connection.phase;
    elements.daemonInstance.textContent = connection.instanceId ? `daemon ${shortId(connection.instanceId)}` : "等待本地守护进程";
    elements.connectionBanner.classList.toggle("visible", connection.phase !== "connected");
    elements.connectionMessage.textContent = friendlyConnectionMessage(connection.message, connection.phase);
    elements.revision.textContent = String(snapshot.kernel.revision);
    const session = snapshot.kernel.sessions[snapshot.selectedSessionId];
    elements.usage.textContent = formatTokens(session?.usage.total ?? 0);
    elements.cache.textContent = formatTokens((session?.usage.cacheRead ?? 0) + (session?.usage.cacheWrite ?? 0));
    elements.notice.textContent = snapshot.notice;
    elements.refresh.disabled = connection.phase !== "connected";
}
function renderSessions(snapshot) {
    const sessions = presentSessions(snapshot.kernel, snapshot.selectedSessionId);
    const nodes = sessions.map((session) => sessionButton(session.id, session.title, session.status, session.depth, session.selected, session.active));
    elements.sessionList.replaceChildren(...nodes);
    elements.sessionCount.textContent = String(sessions.length);
    elements.newSession.disabled = snapshot.connection.phase !== "connected";
    const child = selectedAgent(snapshot);
    elements.childControls.hidden = !child;
    elements.joinAgent.disabled = !child || terminalAgentStatus(child.status) || snapshot.connection.phase !== "connected";
    elements.cancelAgent.disabled = !child || terminalAgentStatus(child.status) || snapshot.connection.phase !== "connected";
    const metrics = kernelMetrics(snapshot.kernel);
    elements.railRuns.textContent = `${metrics.activeRuns}/${metrics.runs}`;
    elements.railMcp.textContent = `${metrics.readyMcpServers}/${metrics.mcpServers}`;
    elements.railResources.textContent = `${metrics.activeResources}/${metrics.resources}`;
    elements.railApprovals.textContent = String(metrics.pendingApprovals);
    elements.railApprovals.classList.toggle("attention", metrics.pendingApprovals > 0);
}
function sessionButton(id, title, status, depth, selected, active) {
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
    const statusMark = element("span", "session-status-mark");
    statusMark.textContent = status;
    button.append(element("i", "node-dot"), copy, statusMark);
    button.addEventListener("click", () => {
        try {
            store.selectSession(id);
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
    elements.modelName.textContent = session?.model ? `${session.model.provider}/${session.model.model}` : "未配置模型";
    elements.composerInput.placeholder = `向 ${child?.id ?? shortId(snapshot.selectedSessionId)} 发送消息…`;
    const connected = snapshot.connection.phase === "connected";
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
    const previousCount = transcriptState.count;
    if (sessionChanged) {
        if (transcriptState.measureFrame !== undefined)
            cancelAnimationFrame(transcriptState.measureFrame);
        transcriptState.heights = new VirtualHeightIndex(180);
        transcriptState.nodes.clear();
        transcriptState.messageSource = undefined;
        transcriptState.items = [];
        transcriptState.hasStreaming = false;
        transcriptState.followTail = true;
    }
    transcriptState.sessionId = snapshot.selectedSessionId;
    transcriptState.count = messages.length;
    if (messages.length === 0 && !streaming && !thinking) {
        transcriptState.heights.sync([]);
        const empty = emptyTranscript(Boolean(child));
        transcript.replaceChildren(empty);
        if (sessionChanged)
            animateTranscriptHero(empty.querySelector(":scope > div"));
        return;
    }
    const hasStreaming = Boolean(streaming || thinking);
    const messagesChanged = transcriptState.messageSource !== messages;
    if (messagesChanged) {
        transcriptState.messageSource = messages;
        transcriptState.items = messages.map((message, index) => ({
            key: messageVirtualKey(message, index),
            message,
        }));
    }
    if (messagesChanged || transcriptState.hasStreaming !== hasStreaming) {
        transcriptState.hasStreaming = hasStreaming;
        transcriptState.heights.sync([
            ...transcriptState.items.map((item) => item.key),
            ...(hasStreaming ? ["$stream"] : []),
        ]);
    }
    const itemCount = transcriptState.items.length + (hasStreaming ? 1 : 0);
    const viewportHeight = Math.max(1, transcript.clientHeight);
    const shouldPin = transcriptState.followTail;
    const scrollTop = shouldPin
        ? Math.max(0, transcriptState.heights.totalSize() - viewportHeight)
        : transcript.scrollTop;
    const range = transcriptState.heights.range(scrollTop, viewportHeight);
    const content = [];
    if (range.paddingStart > 0)
        content.push(virtualSpacer(range.paddingStart, "start"));
    const visibleMessages = [];
    for (let index = range.start; index < range.end; index += 1) {
        const item = transcriptState.items[index];
        const isStreaming = hasStreaming && index === transcriptState.items.length;
        if (!item && !isStreaming)
            continue;
        const key = isStreaming ? "$stream" : item?.key;
        if (!key)
            continue;
        const node = isStreaming
            ? renderStreamingMessage(streaming ?? "", thinking ?? "")
            : cachedMessage(key, item?.message ?? { role: "assistant", text: "" });
        node.dataset["virtualKey"] = key;
        node.dataset["virtualIndex"] = String(index);
        node.setAttribute("aria-posinset", String(index + 1));
        node.setAttribute("aria-setsize", String(itemCount));
        visibleMessages.push(node);
        content.push(node);
    }
    if (range.paddingEnd > 0)
        content.push(virtualSpacer(range.paddingEnd, "end"));
    transcript.setAttribute("aria-busy", String(hasStreaming));
    transcript.replaceChildren(...content);
    if (sessionChanged) {
        animateMessagesIn(visibleMessages.slice(-14), true);
    }
    else if (messages.length > previousCount) {
        animateMessagesIn(visibleMessages.filter((node) => Number(node.dataset["virtualIndex"]) >= previousCount), false);
    }
    if (shouldPin)
        transcript.scrollTo({ top: transcript.scrollHeight, behavior: "auto" });
    scheduleTranscriptMeasurement();
}
function cachedMessage(key, message) {
    const cached = transcriptState.nodes.get(key);
    if (cached) {
        transcriptState.nodes.delete(key);
        transcriptState.nodes.set(key, cached);
        return cached;
    }
    const node = renderMessage(message);
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
        if (transcriptState.followTail) {
            elements.transcript.scrollTo({ top: elements.transcript.scrollHeight, behavior: "auto" });
        }
        if (changed)
            scheduleTranscriptRender();
    });
}
function virtualSpacer(height, edge) {
    const spacer = element("div", `virtual-spacer ${edge}`);
    spacer.style.height = `${Math.max(0, height)}px`;
    spacer.setAttribute("aria-hidden", "true");
    return spacer;
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
        sendNow.disabled = snapshot.connection.phase !== "connected";
        row.append(state, copy, sendNow);
        return row;
    });
    elements.messageQueue.replaceChildren(...directNodes, ...queuedNodes);
}
const MAIN_SESSION_EXAMPLES = [
    "整理 ~/Downloads：按类型归档最近一周的文件，先给出计划",
    "找出这台机器上占用磁盘最多的 10 个目录",
    "每天 09:00 汇总昨天的系统日志异常，并写入长期记忆",
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
            suggestions.append(actionButton(example, "", () => {
                elements.composerInput.value = example;
                elements.composerInput.focus();
            }));
        }
        inner.append(suggestions);
    }
    empty.append(inner);
    return empty;
}
function renderMessage(message) {
    const role = normalizedRole(message.role);
    const article = element("article", `message ${role}`);
    const meta = element("div", "message-meta");
    const label = element("span");
    label.textContent = role === "assistant" ? "pSpore" : role;
    meta.append(element("i", "role-dot"), label);
    if (role === "tool") {
        const details = element("details");
        const summary = element("summary");
        summary.textContent = `工具输出 · ${formatBytes(new TextEncoder().encode(message.text).byteLength)} · 点击展开`;
        const pre = element("pre");
        pre.textContent = message.text || "（无输出）";
        details.append(summary, pre);
        article.append(meta, details);
    }
    else {
        const body = element("div", "message-body markdown");
        appendMarkdown(body, message.text || "（空消息）");
        article.append(meta, body);
    }
    return article;
}
function renderStreamingMessage(value, thinking) {
    const article = element("article", "message assistant streaming");
    const meta = element("div", "message-meta");
    const label = element("span");
    label.textContent = value ? "pSpore · streaming" : "pSpore · thinking";
    meta.append(element("i", "role-dot"), label);
    article.append(meta);
    if (thinking) {
        const reasoning = element("section", "thinking-stream");
        reasoning.setAttribute("aria-label", "思考过程");
        const heading = element("header");
        const title = element("strong");
        title.textContent = "思考中";
        const hint = element("span");
        hint.textContent = "回复完成后自动隐藏";
        heading.append(title, hint);
        const body = element("div", "thinking-stream-body");
        body.append(text(thinking));
        if (!value)
            body.append(element("i", "stream-cursor"));
        reasoning.append(heading, body);
        article.append(reasoning);
    }
    if (value) {
        const body = element("div", "message-body markdown");
        appendMarkdownWithTrailing(body, value, element("i", "stream-cursor"));
        article.append(body);
    }
    return article;
}
function renderActivities(activities) {
    elements.activityCount.textContent = String(activities.length);
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
}
function renderJobs(snapshot) {
    const connected = snapshot.connection.phase === "connected";
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
function renderIntegrations(snapshot) {
    const connected = snapshot.connection.phase === "connected";
    const nodes = [];
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
    const actions = [];
    const denialScope = request.allowedScopes[0] ?? "once";
    actions.push(approvalButton("拒绝", "danger-ghost-button", request, false, denialScope));
    for (const scope of request.allowedScopes) {
        const label = scope === "once" ? "仅此一次" : scope === "session" ? "本会话允许" : "此任务允许";
        actions.push(approvalButton(label, scope === "once" ? "primary-button" : "secondary-button", request, true, scope));
    }
    elements.approvalActions.replaceChildren(...actions);
    if (activeApprovalId !== request.id) {
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
    install.disabled = !result.installable || store.snapshot().connection.phase !== "connected";
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
function isInspection(value) {
    return isRecord(value) && value["version"] === 1 && typeof value["name"] === "string" && typeof value["digest"] === "string" && Array.isArray(value["files"]);
}
function isAgentSnapshot(value) {
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