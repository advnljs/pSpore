/// <reference lib="DOM" />

import type { JobDefinition } from "../../automation/types.js";
import type { SessionView, RuntimeMessage } from "../../domain/runtime.js";
import type { ResourceCatalogEntry, SkillCatalogEntry, StagedResourceInspection } from "../../plugins/types.js";
import { publishedTextTruncation } from "../../protocol/limits.js";
import type { ApprovalRequest } from "../../policy/approval-service.js";
import { defaultModelFor, type ProviderOption } from "../../settings/llm-settings.js";
import {
  clockTime,
  conversationIntent,
  formatBytes,
  formatTokens,
  kernelMetrics,
  listTime,
  presentSessions,
  selectedAgent as findSelectedAgent,
  shortId,
  terminalAgentStatus,
  type SessionListItem,
} from "../../ui/shared/presentation.js";
import { readFullMessage } from "../../ui/shared/full-message.js";
import { isScrollNearEnd, VirtualHeightIndex } from "../../ui/shared/virtual-list.js";
import {
  DAEMON_NOT_CONNECTED_MESSAGE,
} from "../ipc-contract.js";
import type {
  DesktopCommand,
  DesktopIndexingSettings,
  DesktopFrame,
  DesktopLlmSettings,
  DesktopLlmSettingsUpdate,
  DesktopVersions,
} from "../ipc-contract.js";
import {
  composeMessageWithFileReferences,
  composerFileReference,
  composerFileReferenceName,
  mergeComposerFileReferences,
  type ComposerFileReference,
  type ComposerFileReferenceKind,
} from "./composer-file-references.js";
import { appendMarkdown, appendMarkdownWithTrailing } from "./markdown-view.js";
import {
  animateMessagesIn,
  animateTranscriptHero,
  crossfadeText,
  flipStatusChip,
  hideOverlayMotion,
  introChoreography,
  nudgeElement,
  popChips,
  pulseStatus,
  revealListItems,
  revealPanel,
  setReconnectingPulse,
  showOverlayMotion,
  toggleBannerMotion,
  tweenMetric,
} from "./motion.js";
import { CONNECTION_SETTLE_MS, DesktopStore, type DesktopActivity, type DesktopStoreSnapshot } from "./store.js";

const store = new DesktopStore();
const queuedFrames: DesktopFrame[] = [];
let initialized = false;
let versions: DesktopVersions | undefined;
let jobs: JobDefinition[] = [];
let resources: ResourceCatalogEntry[] = [];
/** The fixed tools this build ships, as reported by the daemon. */
let builtinTools: { name: string; label?: string; description?: string }[] = [];
/** Every skill new sessions are offered, and the ones found but not loaded. */
let skillCatalog: SkillCatalogEntry[] = [];
const SKILL_SOURCE_LABELS: Record<SkillCatalogEntry["source"], string> = {
  installed: "已安装",
  bundled: "内置",
  workspace: "本地",
};
let inspection: StagedResourceInspection | undefined;
let activeApprovalId: string | undefined;
let renderSequence = 0;
let settingsOpen = false;
let savingSettings = false;
let responsiveMode: "expansive" | "wide" | "compact" | "narrow" | undefined;
let introPlayed = false;
let lastConnectionPhase = "";
let settleTimer: number | undefined;
let lastSessionSignature = "";
let lastSessionStatus = "";
let lastActivitySignature = "";
let lastReferenceCount = 0;
let indexingDirectories: string[] = [];
/** Session whose delete control is armed, so a stray click cannot destroy history. */
let armedSessionDeletion: string | undefined;
let armSessionDeletionTimer: number | undefined;
let renderFrame: number | undefined;
let transcriptRenderFrame: number | undefined;
let composerFileReferences: ComposerFileReference[] = [];

/** How long a delete control stays armed before it reverts on its own. */
const SESSION_DELETE_ARM_MS = 5_000;

/**
 * The run phase currently on screen and when it began.
 *
 * Elapsed time is measured here rather than taken from the daemon because what
 * the reader is asking is "how long has this been showing me nothing", which is
 * a question about their own screen.
 */
let activityPhase: { key: string; since: number } | undefined;
let activityTicker: number | undefined;

interface TranscriptRenderState {
  sessionId: string;
  /** Absolute transcript position just past the newest rendered message. */
  end: number;
  heights: VirtualHeightIndex;
  nodes: Map<string, HTMLElement>;
  measureFrame: number | undefined;
  messageSource: readonly RuntimeMessage[] | undefined;
  items: Array<{ key: string; message: RuntimeMessage; address: MessageAddress }>;
  hasStreaming: boolean;
  followTail: boolean;
  /** True while an older history page is in flight, so scrolls do not stack. */
  loadingHistory: boolean;
}

const transcriptState: TranscriptRenderState = {
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
};

type Theme = "dark" | "light";
type InspectorTab = "activity" | "automation" | "integrations" | "resources";
const THEME_STORAGE_KEY = "pspore.desktop.theme";
/** Distance from the top that triggers loading the page before the tail. */
const HISTORY_BACKFILL_TRIGGER_PX = 240;
const HISTORY_PAGE_SIZE = 200;
/** How many restored full messages are kept, so scrollback cannot grow forever. */
const FULL_TEXT_CACHE_ENTRIES = 4;

/** How a message is addressed when asking the daemon for its untruncated text. */
type MessageAddress = { id: string } | { index: number };

/**
 * Full text for messages the daemon had to cut, keyed by session and message.
 * Bounded, and dropped oldest-first: restoring a few very long messages must not
 * turn the transcript into an unbounded buffer.
 */
const fullMessageTexts = new Map<string, string>();
const loadingFullText = new Set<string>();

const elements = {
  appShell: byId<HTMLElement>("app-shell"),
  topbar: document.querySelector<HTMLElement>(".topbar") ?? missingElement(".topbar"),
  conversationPanel: document.querySelector<HTMLElement>(".conversation") ?? missingElement(".conversation"),
  navigationPanel: byId<HTMLElement>("navigation-panel"),
  navigationToggle: byId<HTMLButtonElement>("navigation-toggle"),
  inspectorPanel: byId<HTMLElement>("inspector-panel"),
  inspectorToggle: byId<HTMLButtonElement>("inspector-toggle"),
  inspectorClose: byId<HTMLButtonElement>("inspector-close"),
  inspectorTabs: Array.from(document.querySelectorAll<HTMLButtonElement>("[data-inspector-tab]")),
  inspectorViews: Array.from(document.querySelectorAll<HTMLElement>("[data-inspector-panel]")),
  connectionBadge: byId<HTMLSpanElement>("connection-badge"),
  daemonInstance: byId<HTMLSpanElement>("daemon-instance"),
  revision: byId<HTMLElement>("revision-value"),
  usage: byId<HTMLElement>("usage-value"),
  cache: byId<HTMLElement>("cache-value"),
  themeToggle: byId<HTMLButtonElement>("theme-toggle"),
  themeColor: byId<HTMLMetaElement>("theme-color"),
  refresh: byId<HTMLButtonElement>("refresh-button"),
  connectionBanner: byId<HTMLElement>("connection-banner"),
  connectionMessage: byId<HTMLElement>("connection-message"),
  sessionCount: byId<HTMLElement>("session-count"),
  newSession: byId<HTMLButtonElement>("new-session-button"),
  sessionList: byId<HTMLElement>("session-list"),
  runActivity: byId<HTMLElement>("run-activity"),
  runActivityMark: byId<HTMLElement>("run-activity-mark"),
  runActivityLabel: byId<HTMLElement>("run-activity-label"),
  runActivityElapsed: byId<HTMLElement>("run-activity-elapsed"),
  indexingPanel: byId<HTMLElement>("indexing-panel"),
  indexingPhase: byId<HTMLElement>("indexing-phase"),
  indexingBarFill: byId<HTMLElement>("indexing-bar-fill"),
  indexingCounts: byId<HTMLElement>("indexing-counts"),
  indexingCurrent: byId<HTMLElement>("indexing-current"),
  indexingNote: byId<HTMLElement>("indexing-note"),
  railRuns: byId<HTMLElement>("rail-runs"),
  railMcp: byId<HTMLElement>("rail-mcp"),
  railResources: byId<HTMLElement>("rail-resources"),
  railApprovals: byId<HTMLElement>("rail-approvals"),
  agentCompose: byId<HTMLElement>("agent-compose"),
  agentComposeToggle: byId<HTMLButtonElement>("agent-compose-toggle"),
  agentComposeClose: byId<HTMLButtonElement>("agent-compose-close"),
  spawnForm: byId<HTMLFormElement>("spawn-form"),
  spawnObjective: byId<HTMLTextAreaElement>("spawn-objective"),
  childControls: byId<HTMLElement>("child-controls"),
  joinAgent: byId<HTMLButtonElement>("join-agent-button"),
  cancelAgent: byId<HTMLButtonElement>("cancel-agent-button"),
  inspectForm: byId<HTMLFormElement>("inspect-form"),
  stagingName: byId<HTMLInputElement>("staging-name"),
  inspectionResult: byId<HTMLElement>("inspection-result"),
  resourceShortcut: byId<HTMLButtonElement>("resource-shortcut"),
  versionLine: byId<HTMLElement>("version-line"),
  runtimeLine: byId<HTMLElement>("runtime-line"),
  sessionTitle: byId<HTMLElement>("session-title"),
  sessionStatus: byId<HTMLElement>("session-status"),
  modelName: byId<HTMLElement>("model-name"),
  transcript: byId<HTMLElement>("transcript"),
  notice: byId<HTMLElement>("notice-line"),
  messageQueue: byId<HTMLElement>("message-queue"),
  composerForm: byId<HTMLFormElement>("composer-form"),
  composerInput: byId<HTMLTextAreaElement>("composer-input"),
  composerDropOverlay: byId<HTMLElement>("composer-drop-overlay"),
  composerReferences: byId<HTMLElement>("composer-references"),
  compact: byId<HTMLButtonElement>("compact-button"),
  abort: byId<HTMLButtonElement>("abort-button"),
  send: byId<HTMLButtonElement>("send-button"),
  activityCount: byId<HTMLElement>("activity-count"),
  activityList: byId<HTMLElement>("activity-list"),
  jobList: byId<HTMLElement>("job-list"),
  runList: byId<HTMLElement>("run-list"),
  integrationList: byId<HTMLElement>("integration-list"),
  notificationList: byId<HTMLElement>("notification-list"),
  settingsButton: byId<HTMLButtonElement>("settings-button"),
  settingsOverlay: byId<HTMLElement>("settings-overlay"),
  settingsDialog: document.querySelector<HTMLElement>(".settings-dialog") ?? missingElement(".settings-dialog"),
  settingsClose: byId<HTMLButtonElement>("settings-close"),
  settingsCancel: byId<HTMLButtonElement>("settings-cancel"),
  settingsForm: byId<HTMLFormElement>("settings-form"),
  settingsProvider: byId<HTMLSelectElement>("settings-provider"),
  settingsProviderHelp: byId<HTMLElement>("settings-provider-help"),
  settingsModel: byId<HTMLInputElement>("settings-model"),
  settingsBaseUrl: byId<HTMLInputElement>("settings-base-url"),
  settingsApi: byId<HTMLSelectElement>("settings-api"),
  settingsThinking: byId<HTMLSelectElement>("settings-thinking"),
  settingsPermissionMode: byId<HTMLSelectElement>("settings-permission-mode"),
  settingsPermissionHelp: byId<HTMLElement>("settings-permission-help"),
  settingsPermissionWarning: byId<HTMLElement>("settings-permission-warning"),
  settingsAutoCompaction: byId<HTMLInputElement>("settings-auto-compaction"),
  settingsCompactionTrigger: byId<HTMLInputElement>("settings-compaction-trigger"),
  settingsCompactionReserve: byId<HTMLInputElement>("settings-compaction-reserve"),
  settingsCompactionKeepRecent: byId<HTMLInputElement>("settings-compaction-keep-recent"),
  settingsApiKey: byId<HTMLInputElement>("settings-api-key"),
  settingsKeyReveal: byId<HTMLButtonElement>("settings-key-reveal"),
  settingsClearKey: byId<HTMLInputElement>("settings-clear-key"),
  settingsCookie: byId<HTMLInputElement>("settings-cookie"),
  settingsCookieReveal: byId<HTMLButtonElement>("settings-cookie-reveal"),
  settingsClearCookie: byId<HTMLInputElement>("settings-clear-cookie"),
  settingsConfigPath: byId<HTMLElement>("settings-config-path"),
  settingsModelsPath: byId<HTMLElement>("settings-models-path"),
  settingsApiKeyPath: byId<HTMLElement>("settings-api-key-path"),
  settingsApiKeyState: byId<HTMLElement>("settings-api-key-state"),
  settingsKeyCopyPath: byId<HTMLButtonElement>("settings-key-copy-path"),
  settingsCookiePath: byId<HTMLElement>("settings-cookie-path"),
  settingsCookieState: byId<HTMLElement>("settings-cookie-state"),
  settingsCookieCopyPath: byId<HTMLButtonElement>("settings-cookie-copy-path"),
  settingsIndexingEnabled: byId<HTMLInputElement>("settings-indexing-enabled"),
  settingsIndexingInterval: byId<HTMLInputElement>("settings-indexing-interval"),
  settingsIndexingExt: byId<HTMLInputElement>("settings-indexing-ext"),
  settingsIndexingAdd: byId<HTMLButtonElement>("settings-indexing-add"),
  settingsIndexingList: byId<HTMLElement>("settings-indexing-list"),
  settingsIndexingNote: byId<HTMLElement>("settings-indexing-note"),
  settingsStatus: byId<HTMLElement>("settings-status"),
  settingsSave: byId<HTMLButtonElement>("settings-save"),
  approvalOverlay: byId<HTMLElement>("approval-overlay"),
  approvalDialog: document.querySelector<HTMLElement>(".approval-dialog") ?? missingElement(".approval-dialog"),
  approvalTitle: byId<HTMLElement>("approval-title"),
  approvalSummary: byId<HTMLElement>("approval-summary"),
  approvalCapability: byId<HTMLElement>("approval-capability"),
  approvalTarget: byId<HTMLElement>("approval-target"),
  approvalReasons: byId<HTMLElement>("approval-reasons"),
  approvalCommand: byId<HTMLElement>("approval-command"),
  approvalActions: byId<HTMLElement>("approval-actions"),
};

applyTheme(initialTheme());
syncResponsivePanels(true);

const unsubscribe = window.pspore.subscribe((frame) => {
  if (!initialized) queuedFrames.push(frame);
  else {
    store.applyFrame(frame);
    scheduleRender();
  }
});

window.addEventListener("beforeunload", unsubscribe, { once: true });

void initialize();

async function initialize(): Promise<void> {
  bindStaticActions();
  try {
    const bootstrap = await window.pspore.bootstrap();
    versions = bootstrap.versions;
    store.applyBootstrap(bootstrap);
    initialized = true;
    for (const frame of queuedFrames.splice(0)) store.applyFrame(frame);
    render();
    await refreshSideData();
  } catch (error) {
    initialized = true;
    store.setNotice(`桌面初始化失败：${toError(error).message}`);
    render();
  } finally {
    document.documentElement.dataset["ready"] = "true";
    playIntroOnce();
  }
}

function playIntroOnce(): void {
  if (introPlayed) return;
  introPlayed = true;
  introChoreography(elements.topbar, [elements.navigationPanel, elements.conversationPanel, elements.inspectorPanel]);
}

function bindStaticActions(): void {
  elements.navigationToggle.addEventListener("click", () => {
    setPanelState("navigation", document.documentElement.dataset["navigation"] !== "open");
  });
  elements.inspectorToggle.addEventListener("click", () => {
    setPanelState("inspector", document.documentElement.dataset["inspector"] !== "open");
  });
  elements.inspectorClose.addEventListener("click", () => setPanelState("inspector", false));
  for (const tab of elements.inspectorTabs) {
    tab.addEventListener("click", () => selectInspectorTab(tab.dataset["inspectorTab"] as InspectorTab));
  }
  elements.agentComposeToggle.addEventListener("click", () => setAgentCompose(elements.agentCompose.hidden));
  elements.agentComposeClose.addEventListener("click", () => setAgentCompose(false));
  elements.resourceShortcut.addEventListener("click", () => {
    selectInspectorTab("resources");
    setPanelState("inspector", true);
  });
  window.addEventListener("resize", () => {
    syncResponsivePanels(false);
    scheduleResizeReflow();
  });
  elements.themeToggle.addEventListener("click", () => {
    const theme: Theme = document.documentElement.dataset["theme"] === "light" ? "dark" : "light";
    applyTheme(theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Theme remains active for this session when local persistence is unavailable.
    }
  });
  elements.refresh.addEventListener("click", () => void refreshSideData());
  elements.newSession.addEventListener("click", () => {
    void perform("新建会话", { action: "session.create" }, (result) => {
      if (!isSessionView(result)) throw new Error("服务返回了无效的会话");
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
  bindPathCopy(elements.settingsKeyCopyPath, elements.settingsApiKeyPath);
  elements.settingsIndexingAdd.addEventListener("click", () => void addIndexingDirectory());
  bindPathCopy(elements.settingsCookieCopyPath, elements.settingsCookiePath);
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
    if (event.key !== "Enter" || event.isComposing) return;
    // Enter sends; Ctrl/Cmd+Enter, Shift+Enter and Alt+Enter insert a newline.
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    elements.composerForm.requestSubmit();
  });
  bindComposerFileDrop();
  elements.transcript.addEventListener("scroll", handleTranscriptScroll, { passive: true });
  elements.spawnForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const objective = elements.spawnObjective.value.trim();
    if (!objective) return;
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
    const command: DesktopCommand = child
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
    if (child) void perform(`等待 ${child.id} 完成`, { action: "agent.join", agentIds: [child.id] });
  });
  elements.cancelAgent.addEventListener("click", () => {
    const child = selectedAgent(store.snapshot());
    if (child) void perform(`取消 ${child.id}`, { action: "agent.cancel", agentId: child.id });
  });
  elements.inspectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const stagingName = elements.stagingName.value.trim();
    if (!stagingName) return;
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

function bindComposerFileDrop(): void {
  elements.composerForm.addEventListener("dragenter", (event) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    setComposerDropActive(true);
  });
  elements.composerForm.addEventListener("dragover", (event) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setComposerDropActive(true);
  });
  elements.composerForm.addEventListener("dragleave", (event) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && elements.composerForm.contains(nextTarget)) return;
    setComposerDropActive(false);
  });
  elements.composerForm.addEventListener("drop", (event) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setComposerDropActive(false);
    const incoming = droppedComposerFileReferences(event.dataTransfer);
    const merged = mergeComposerFileReferences(composerFileReferences, incoming);
    composerFileReferences = merged.references;
    renderComposerFileReferences();
    if (merged.added > 0) {
      const ignored = merged.skipped > 0 ? `；另有 ${merged.skipped} 个重复引用或超出上限` : "";
      store.setNotice(`已添加 ${merged.added} 个文件/目录引用，仅会发送路径${ignored}`);
    } else {
      store.setNotice(incoming.length > 0 ? "这些路径已经引用，未重复添加" : "未能从拖入项获取本地文件或目录路径");
    }
    render();
    elements.composerInput.focus();
  });
  window.addEventListener("dragend", () => setComposerDropActive(false));
}

function hasDraggedFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  return Array.from(transfer.types).includes("Files") || Array.from(transfer.items).some((item) => item.kind === "file");
}

function setComposerDropActive(active: boolean): void {
  elements.composerForm.dataset["dropActive"] = String(active);
  elements.composerDropOverlay.hidden = !active;
}

function droppedComposerFileReferences(transfer: DataTransfer | null): ComposerFileReference[] {
  if (!transfer) return [];
  const references = new Map<string, ComposerFileReference>();
  const add = (file: File | null, kind: ComposerFileReferenceKind): void => {
    if (!file) return;
    try {
      const reference = composerFileReference(window.pspore.getPathForFile(file), kind);
      if (reference && !references.has(reference.path)) references.set(reference.path, reference);
    } catch {
      // Browser-created Files have no operating-system path and are not valid references.
    }
  };

  for (const item of Array.from(transfer.items)) {
    if (item.kind !== "file") continue;
    let kind: ComposerFileReferenceKind = "file";
    try {
      if (item.webkitGetAsEntry()?.isDirectory) kind = "directory";
    } catch {
      // The path remains usable even when Chromium cannot expose entry metadata.
    }
    add(item.getAsFile(), kind);
  }
  for (const file of Array.from(transfer.files)) add(file, "file");
  return [...references.values()];
}

function renderComposerFileReferences(): void {
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
    const remove = element("button", "composer-reference-remove") as HTMLButtonElement;
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
  if (added) popChips(nodes);
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
let resizeReflowTimer: number | undefined;
function scheduleResizeReflow(): void {
  if (resizeReflowTimer !== undefined) window.clearTimeout(resizeReflowTimer);
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

function syncResponsivePanels(force: boolean): void {
  // Only a full desktop viewport has room for all three columns; narrower windows keep the conversation dominant.
  const width = window.innerWidth;
  const nextMode = width <= 1_160 ? "narrow" : width <= 1_320 ? "compact" : width < 1_600 ? "wide" : "expansive";
  if (!force && nextMode === responsiveMode) return;
  responsiveMode = nextMode;
  setPanelState("navigation", nextMode !== "narrow");
  setPanelState("inspector", nextMode === "expansive");
}

function setPanelState(panel: "navigation" | "inspector", open: boolean): void {
  document.documentElement.dataset[panel] = open ? "open" : "closed";
  const button = panel === "navigation" ? elements.navigationToggle : elements.inspectorToggle;
  button.setAttribute("aria-expanded", String(open));
  const label = panel === "navigation"
    ? open ? "收起会话栏" : "展开会话栏"
    : open ? "收起检查器" : "展开检查器";
  button.setAttribute("aria-label", label);
  button.title = label;
}

function selectInspectorTab(selected: InspectorTab): void {
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
    if (becameVisible) revealPanel(view);
  }
}

function setAgentCompose(open: boolean): void {
  elements.agentCompose.hidden = !open;
  elements.agentComposeToggle.setAttribute("aria-expanded", String(open));
  if (open) requestAnimationFrame(() => elements.spawnObjective.focus());
}

async function openSettings(): Promise<void> {
  if (!elements.approvalOverlay.hidden) return;
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
  } catch (error) {
    elements.settingsStatus.textContent = `读取失败：${toError(error).message}`;
  }
}

function populateIndexingSettings(indexing: DesktopIndexingSettings): void {
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
function indexingSettingsNote(indexing: DesktopIndexingSettings): string {
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

function renderIndexingDirectories(): void {
  elements.settingsIndexingList.replaceChildren(...indexingDirectories.map((directory) => {
    const row = element("div", "indexing-dir");
    row.setAttribute("role", "listitem");
    const path = element("code");
    path.textContent = directory;
    const remove = element("button", "quiet-text-button") as HTMLButtonElement;
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

async function addIndexingDirectory(): Promise<void> {
  // The renderer has no filesystem access, so the absolute path can only come
  // from the main process's native chooser.
  const directory = await window.pspore.pickIndexDirectory();
  if (!directory || indexingDirectories.includes(directory)) return;
  indexingDirectories = [...indexingDirectories, directory].sort();
  renderIndexingDirectories();
  popChips(Array.from(elements.settingsIndexingList.children));
}

function populateSettings(settings: DesktopLlmSettings): void {
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
}

/**
 * Secrets stay in files outside `config.json`, so the panel shows exactly where
 * each one is read from. Only the path is ever rendered — never the value.
 */
function populateSettingsPaths(settings: DesktopLlmSettings): void {
  elements.settingsConfigPath.textContent = settings.configPath;
  elements.settingsModelsPath.textContent = settings.modelsPath;
  elements.settingsApiKeyPath.textContent = settings.apiKeyPath;
  elements.settingsCookiePath.textContent = settings.cookiePath;
  elements.settingsApiKeyState.textContent = settings.hasApiKey ? "已配置" : "未配置";
  elements.settingsApiKeyState.dataset["state"] = settings.hasApiKey ? "present" : "absent";
  elements.settingsCookieState.textContent = settings.hasCookie ? "已配置" : "未配置";
  elements.settingsCookieState.dataset["state"] = settings.hasCookie ? "present" : "absent";
}

function bindPathCopy(button: HTMLButtonElement, source: HTMLElement): void {
  button.addEventListener("click", () => {
    const path = source.textContent ?? "";
    if (!path || path === "—") return;
    void navigator.clipboard.writeText(path).then(
      () => flashButtonLabel(button, "已复制"),
      () => flashButtonLabel(button, "复制失败"),
    );
  });
}

function flashButtonLabel(button: HTMLButtonElement, label: string): void {
  const original = button.dataset["label"] ?? button.textContent ?? "";
  button.dataset["label"] = original;
  button.textContent = label;
  nudgeElement(button);
  window.setTimeout(() => {
    button.textContent = button.dataset["label"] ?? original;
  }, 1_400);
}

async function saveSettings(): Promise<void> {
  if (savingSettings) return;
  const update: DesktopLlmSettingsUpdate = {
    provider: elements.settingsProvider.value as ProviderOption,
    model: elements.settingsModel.value.trim(),
    baseUrl: elements.settingsBaseUrl.value.trim(),
    api: elements.settingsApi.value as DesktopLlmSettingsUpdate["api"],
    thinking: elements.settingsThinking.value as DesktopLlmSettingsUpdate["thinking"],
    customModel: elements.settingsProvider.value === "custom-openai",
    permissionMode: elements.settingsPermissionMode.value as DesktopLlmSettingsUpdate["permissionMode"],
    autoCompactionEnabled: elements.settingsAutoCompaction.checked,
    autoCompactionTriggerTokens: elements.settingsCompactionTrigger.valueAsNumber,
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
    // Indexing is a separate config section; saving it here keeps one button.
    const indexing = await window.pspore.saveIndexing({
      enabled: elements.settingsIndexingEnabled.checked,
      directories: [...indexingDirectories],
      intervalMinutes: elements.settingsIndexingInterval.valueAsNumber,
      extensions: elements.settingsIndexingExt.value.split(",").map((value) => value.trim()).filter(Boolean),
    });
    populateIndexingSettings(indexing.settings);
    elements.settingsStatus.textContent = `${result.message} ${indexing.message}`;
  } catch (error) {
    elements.settingsStatus.textContent = `保存失败：${toError(error).message}`;
  } finally {
    savingSettings = false;
    elements.settingsSave.disabled = false;
    elements.settingsCancel.disabled = false;
    elements.settingsClose.disabled = false;
  }
}

const PERMISSION_MODE_HELP: Partial<Record<DesktopLlmSettingsUpdate["permissionMode"], string>> = {
  ask_risky: "越界操作会先弹出批准请求。",
  ask_all: "所有写入、执行与外部副作用类工具都会先请求批准。",
  allow_all: "所有工具立即执行，不再产生批准请求。",
  deny: "所有受控工具都会被直接拒绝，只保留纯读取能力。",
};

function configurePermissionFields(): void {
  const mode = elements.settingsPermissionMode.value as DesktopLlmSettingsUpdate["permissionMode"];
  elements.settingsPermissionWarning.hidden = mode !== "allow_all";
  elements.settingsPermissionHelp.textContent = PERMISSION_MODE_HELP[mode] ?? PERMISSION_MODE_HELP["ask_risky"] ?? "";
}

function configureProviderFields(resetModel: boolean): void {
  const provider = elements.settingsProvider.value as ProviderOption;
  const custom = provider === "custom-openai";
  if (resetModel) elements.settingsModel.value = defaultModelFor(provider);
  elements.settingsBaseUrl.disabled = !custom;
  elements.settingsBaseUrl.required = custom;
  elements.settingsApi.disabled = !custom;
  if (custom) {
    if (elements.settingsApi.value === "provider-default") elements.settingsApi.value = "openai-completions";
    elements.settingsProviderHelp.textContent = "使用 OpenAI 兼容接口；必须填写 Base URL，并选择 Chat Completions 或 Responses。";
    elements.settingsBaseUrl.placeholder = "例如 https://gateway.example.com/v1";
  } else {
    elements.settingsBaseUrl.value = "";
    elements.settingsApi.value = "provider-default";
    elements.settingsProviderHelp.textContent = provider === "deepseek"
      ? "使用 DeepSeek 内置模型目录与默认接口。"
      : "使用 OpenAI 内置模型目录与默认接口。";
    elements.settingsBaseUrl.placeholder = "选择“自定义 OpenAI”后配置";
  }
}

function closeSettings(restoreFocus = true): void {
  if (!settingsOpen || savingSettings) return;
  settingsOpen = false;
  elements.settingsApiKey.value = "";
  elements.settingsApiKey.type = "password";
  elements.settingsCookie.value = "";
  elements.settingsCookie.type = "password";
  updateAppInert();
  hideOverlayMotion(elements.settingsOverlay, elements.settingsDialog, () => {
    if (!settingsOpen) elements.settingsOverlay.hidden = true;
  });
  if (restoreFocus) requestAnimationFrame(() => elements.settingsButton.focus());
}

function updateAppInert(): void {
  const inert = settingsOpen || !elements.approvalOverlay.hidden;
  elements.appShell.inert = inert;
  if (inert) elements.appShell.setAttribute("aria-hidden", "true");
  else elements.appShell.removeAttribute("aria-hidden");
}

function trapDialogFocus(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== "Tab") return;
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(
    "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
  )).filter((candidate) => candidate.offsetParent !== null);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function submitComposer(): Promise<void> {
  let text: string;
  try {
    text = composeMessageWithFileReferences(elements.composerInput.value, composerFileReferences);
  } catch (error) {
    store.setNotice(toError(error).message);
    render();
    return;
  }
  if (!text) return;
  nudgeElement(elements.send);
  const snapshot = store.snapshot();
  const intent = conversationIntent(
    snapshot.kernel,
    snapshot.selectedSessionId,
    text,
    "auto",
  );
  let command: DesktopCommand;
  if (intent.target === "agent") {
    command = {
      action: "agent.send",
      agentId: intent.agentId,
      message: intent.text,
      mode: intent.mode,
    };
  } else {
    command = { action: "prompt", text: intent.text, sessionId: intent.sessionId };
  }
  await perform(`发送到 ${intent.target === "agent" ? intent.agentId : shortId(intent.sessionId)}`, command, () => {
    elements.composerInput.value = "";
    composerFileReferences = [];
    renderComposerFileReferences();
    elements.composerInput.focus();
  });
}

async function perform(
  pendingNotice: string,
  command: DesktopCommand,
  onSuccess?: (result: unknown) => void | Promise<void>,
): Promise<void> {
  store.setNotice(`正在${pendingNotice}…`);
  render();
  try {
    const result = await dispatchAcrossReconnect(command);
    store.setNotice(`${pendingNotice}：完成`);
    await onSuccess?.(result);
  } catch (error) {
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
async function dispatchAcrossReconnect(command: DesktopCommand): Promise<unknown> {
  try {
    return await window.pspore.dispatch(command);
  } catch (error) {
    const message = toError(error).message;
    if (!message.includes(DAEMON_NOT_CONNECTED_MESSAGE) || !store.snapshot().reconnecting) throw error;
    store.setNotice("守护进程正在重连，命令将在连接恢复后发送…");
    render();
    if (!(await waitForConnection())) throw error;
    return window.pspore.dispatch(command);
  }
}

function waitForConnection(): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + CONNECTION_SETTLE_MS;
    const poll = (): void => {
      if (store.snapshot().connection.phase === "connected") resolve(true);
      else if (Date.now() >= deadline) resolve(false);
      else window.setTimeout(poll, 100);
    };
    poll();
  });
}

async function refreshSideData(): Promise<void> {
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

function render(): void {
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
function scheduleConnectionSettle(snapshot: DesktopStoreSnapshot): void {
  if (!snapshot.reconnecting) {
    if (settleTimer !== undefined) {
      window.clearTimeout(settleTimer);
      settleTimer = undefined;
    }
    return;
  }
  if (settleTimer !== undefined) return;
  settleTimer = window.setTimeout(() => {
    settleTimer = undefined;
    if (store.settleConnection()) scheduleRender();
    else scheduleConnectionSettle(store.snapshot());
  }, 250);
}

function scheduleRender(): void {
  if (renderFrame !== undefined) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = undefined;
    render();
  });
}

function scheduleTranscriptRender(): void {
  if (transcriptRenderFrame !== undefined) return;
  transcriptRenderFrame = requestAnimationFrame(() => {
    transcriptRenderFrame = undefined;
    if (initialized) renderConversation(store.snapshot());
  });
}

function handleTranscriptScroll(): void {
  transcriptState.followTail = isScrollNearEnd(
    elements.transcript.scrollHeight,
    elements.transcript.scrollTop,
    elements.transcript.clientHeight,
  );
  if (elements.transcript.scrollTop < HISTORY_BACKFILL_TRIGGER_PX) void loadOlderHistory();
  scheduleTranscriptRender();
}

/**
 * Broadcasts carry only the newest part of a conversation, so scrolling to the
 * top asks the daemon for the page before it. The viewport is pinned to the
 * message the reader was looking at rather than to a scroll offset that the
 * prepended history has just moved.
 */
async function loadOlderHistory(): Promise<void> {
  if (transcriptState.loadingHistory) return;
  const snapshot = store.snapshot();
  const sessionId = snapshot.selectedSessionId;
  const session = snapshot.kernel.sessions[sessionId];
  if (!session || session.messageOffset === 0) return;
  const from = Math.max(0, session.messageOffset - HISTORY_PAGE_SIZE);
  transcriptState.loadingHistory = true;
  try {
    const page = await dispatchAcrossReconnect({
      action: "session.transcript",
      sessionId,
      from,
      limit: session.messageOffset - from,
    });
    if (!isTranscriptPage(page) || page.sessionId !== store.snapshot().selectedSessionId) return;
    const anchor = elements.transcript.scrollHeight - elements.transcript.scrollTop;
    if (!store.applyTranscriptPage(page)) return;
    render();
    elements.transcript.scrollTop = Math.max(0, elements.transcript.scrollHeight - anchor);
  } catch {
    // A refused or disconnected backfill simply leaves the history where it is.
  } finally {
    transcriptState.loadingHistory = false;
  }
}

function isTranscriptPage(value: unknown): value is {
  sessionId: string;
  from: number;
  count: number;
  messages: Array<{ role: string; text: string }>;
} {
  if (typeof value !== "object" || value === null) return false;
  const page = value as Record<string, unknown>;
  return typeof page["sessionId"] === "string"
    && typeof page["from"] === "number"
    && typeof page["count"] === "number"
    && Array.isArray(page["messages"]);
}

function renderHeader(snapshot: DesktopStoreSnapshot): void {
  // The settled state is what the header shows: a reconnect that finishes inside
  // the settle window stays "ONLINE" so a long run does not strobe the badge.
  const connection = snapshot.stableConnection;
  elements.connectionBadge.className = `connection-badge ${connection.phase}`;
  elements.connectionBadge.dataset["reconnecting"] = snapshot.reconnecting ? "true" : "false";
  elements.connectionBadge.replaceChildren(element("i"), text(connection.phase === "connected" ? "ONLINE" : connection.phase.toUpperCase()));
  if (lastConnectionPhase && connection.phase !== lastConnectionPhase) pulseStatus(elements.connectionBadge);
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

function renderSessions(snapshot: DesktopStoreSnapshot): void {
  const sessions = presentSessions(snapshot.kernel, snapshot.selectedSessionId);
  const connected = snapshot.stableConnection.phase === "connected";
  const nodes = sessions.map((session) => sessionRow(session, connected));
  const sessionSignature = sessions
    .map((session) => `${session.id}:${session.status}:${session.selected}:${session.id === armedSessionDeletion}`)
    .join("|");
  elements.sessionList.replaceChildren(...nodes);
  if (sessionSignature !== lastSessionSignature) {
    if (lastSessionSignature) revealListItems(nodes, { distance: 6 });
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
function sessionRow(session: SessionListItem, connected: boolean): HTMLElement {
  const row = element("div", `session-row${session.id === armedSessionDeletion ? " arming" : ""}`);
  row.append(sessionButton(
    session.id,
    session.title,
    session.status,
    session.depth,
    session.selected,
    session.active,
    session.createdAt,
  ));
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
function sessionDeleteButton(session: SessionListItem, connected: boolean): HTMLButtonElement {
  const armed = session.id === armedSessionDeletion;
  const button = element("button", `session-delete${armed ? " armed" : ""}`) as HTMLButtonElement;
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
function armSessionDeletion(id: string): void {
  if (armSessionDeletionTimer !== undefined) clearTimeout(armSessionDeletionTimer);
  armedSessionDeletion = id;
  armSessionDeletionTimer = window.setTimeout(() => {
    armedSessionDeletion = undefined;
    armSessionDeletionTimer = undefined;
    render();
  }, SESSION_DELETE_ARM_MS);
  render();
}

function disarmSessionDeletion(): void {
  if (armSessionDeletionTimer !== undefined) clearTimeout(armSessionDeletionTimer);
  armSessionDeletionTimer = undefined;
  armedSessionDeletion = undefined;
}

function sessionButton(
  id: string,
  title: string,
  status: string,
  depth: number,
  selected: boolean,
  active: boolean,
  createdAt?: string,
): HTMLButtonElement {
  const button = element("button", `session-item ${status}${selected ? " selected" : ""}`) as HTMLButtonElement;
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
      render();
    } catch (error) {
      store.setNotice(toError(error).message);
      render();
    }
  });
  return button;
}

function renderConversation(snapshot: DesktopStoreSnapshot): void {
  const session = snapshot.kernel.sessions[snapshot.selectedSessionId];
  const child = selectedAgent(snapshot);
  elements.sessionTitle.textContent = child
    ? `${shortId(child.id)} · ${child.objective}`
    : session?.rootSession?.title ?? (snapshot.selectedSessionId === "main" ? "main" : shortId(snapshot.selectedSessionId));
  const status = session?.status ?? (child?.status ?? "idle");
  elements.sessionStatus.textContent = status.toUpperCase();
  elements.sessionStatus.className = `status-chip ${status}`;
  if (lastSessionStatus && status !== lastSessionStatus) flipStatusChip(elements.sessionStatus);
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
    if (transcriptState.measureFrame !== undefined) cancelAnimationFrame(transcriptState.measureFrame);
    transcriptState.heights = new VirtualHeightIndex(180);
    transcriptState.nodes.clear();
    transcriptState.messageSource = undefined;
    transcriptState.items = [];
    transcriptState.hasStreaming = false;
    transcriptState.followTail = true;
  }
  transcriptState.sessionId = snapshot.selectedSessionId;
  transcriptState.end = offset + messages.length;
  if (messages.length === 0 && !streaming && !thinking) {
    transcriptState.heights.sync([]);
    const empty = emptyTranscript(Boolean(child));
    transcript.replaceChildren(empty);
    if (sessionChanged) animateTranscriptHero(empty.querySelector(":scope > div"));
    return;
  }

  const hasStreaming = Boolean(streaming || thinking);
  const messagesChanged = transcriptState.messageSource !== messages;
  if (messagesChanged) {
    transcriptState.messageSource = messages;
    // Keyed by absolute transcript position, so prepending older history keeps
    // the keys — and therefore the measured heights — of what is on screen.
    transcriptState.items = messages.map((message, index) => {
      const address: MessageAddress = message.id === undefined ? { index: offset + index } : { id: message.id };
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
  const viewportHeight = Math.max(1, transcript.clientHeight);
  const shouldPin = transcriptState.followTail;
  const scrollTop = shouldPin
    ? Math.max(0, transcriptState.heights.totalSize() - viewportHeight)
    : transcript.scrollTop;
  const range = transcriptState.heights.range(scrollTop, viewportHeight);
  const content: HTMLElement[] = [];
  if (range.paddingStart > 0) content.push(virtualSpacer(range.paddingStart, "start"));
  const visibleMessages: HTMLElement[] = [];
  for (let index = range.start; index < range.end; index += 1) {
    const item = transcriptState.items[index];
    const isStreaming = hasStreaming && index === transcriptState.items.length;
    if (!item && !isStreaming) continue;
    const key = isStreaming ? "$stream" : item?.key;
    if (!key) continue;
    const node = isStreaming
      ? renderStreamingMessage(streaming ?? "", thinking ?? "")
      : cachedMessage(key, item?.message ?? { role: "assistant", text: "" }, item?.address ?? { index });
    node.dataset["virtualKey"] = key;
    node.dataset["virtualIndex"] = String(index);
    node.setAttribute("aria-posinset", String(index + 1));
    node.setAttribute("aria-setsize", String(itemCount));
    visibleMessages.push(node);
    content.push(node);
  }
  if (range.paddingEnd > 0) content.push(virtualSpacer(range.paddingEnd, "end"));
  transcript.setAttribute("aria-busy", String(hasStreaming));
  transcript.replaceChildren(...content);
  if (sessionChanged) {
    animateMessagesIn(visibleMessages.slice(-14), true);
  } else if (transcriptState.end > previousEnd) {
    // Compared at absolute positions: a history backfill grows the list without
    // adding anything new at the tail, and must not replay the entrance.
    const firstAppended = transcriptState.items.length - (transcriptState.end - previousEnd);
    animateMessagesIn(visibleMessages.filter((node) => Number(node.dataset["virtualIndex"]) >= firstAppended), false);
  }
  if (shouldPin) transcript.scrollTo({ top: transcript.scrollHeight, behavior: "auto" });
  scheduleTranscriptMeasurement();
}

function cachedMessage(key: string, message: RuntimeMessage, address: MessageAddress): HTMLElement {
  const cached = transcriptState.nodes.get(key);
  if (cached) {
    transcriptState.nodes.delete(key);
    transcriptState.nodes.set(key, cached);
    return cached;
  }
  const node = renderMessage(message, address);
  transcriptState.nodes.set(key, node);
  while (transcriptState.nodes.size > 128) {
    const oldest = transcriptState.nodes.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    transcriptState.nodes.delete(oldest);
  }
  return node;
}

function scheduleTranscriptMeasurement(): void {
  if (transcriptState.measureFrame !== undefined) cancelAnimationFrame(transcriptState.measureFrame);
  transcriptState.measureFrame = requestAnimationFrame(() => {
    transcriptState.measureFrame = undefined;
    let changed = false;
    for (const node of Array.from(elements.transcript.querySelectorAll<HTMLElement>("[data-virtual-key]"))) {
      const key = node.dataset["virtualKey"];
      if (!key) continue;
      const margin = Number.parseFloat(getComputedStyle(node).marginBottom) || 0;
      changed = transcriptState.heights.update(key, node.offsetHeight + margin) || changed;
    }
    if (transcriptState.followTail) {
      elements.transcript.scrollTo({ top: elements.transcript.scrollHeight, behavior: "auto" });
    }
    if (changed) scheduleTranscriptRender();
  });
}

function virtualSpacer(height: number, edge: "start" | "end"): HTMLElement {
  const spacer = element("div", `virtual-spacer ${edge}`);
  spacer.style.height = `${Math.max(0, height)}px`;
  spacer.setAttribute("aria-hidden", "true");
  return spacer;
}

function messageVirtualKey(message: RuntimeMessage, index: number): string {
  return `${index}:${message.role}:${message.text.length}:${textFingerprint(message.text)}`;
}

function textFingerprint(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function renderMessageQueue(snapshot: DesktopStoreSnapshot, session: SessionView | undefined): void {
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

const MAIN_SESSION_EXAMPLES = [
  "整理 ~/Downloads：按类型归档最近一周的文件，先给出计划",
  "找出这台机器上占用磁盘最多的 10 个目录",
  "每天 09:00 汇总昨天的系统日志异常，并写入长期记忆",
] as const;

function emptyTranscript(isChild: boolean): HTMLElement {
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

function renderMessage(message: RuntimeMessage, address: MessageAddress): HTMLElement {
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
  } else {
    const body = element("div", "message-body markdown");
    appendMarkdown(body, message.text || "（空消息）");
    article.append(meta, body);
  }
  const truncation = publishedTextTruncation(message.text);
  if (truncation) article.append(truncationNotice(address, truncation));
  return article;
}

/**
 * Offers the rest of a message the daemon had to cut. The publishing ceiling
 * keeps one enormous message from crowding out everything else on the wire, so
 * the full text is something a reader asks for rather than something every
 * broadcast carries.
 */
function truncationNotice(address: MessageAddress, truncation: { kept: number; total: number }): HTMLElement {
  const notice = element("div", "message-truncated");
  const summary = element("span");
  summary.textContent = `仅显示前 ${truncation.kept.toLocaleString("zh-CN")} / ${truncation.total.toLocaleString("zh-CN")} 个字符`;
  const button = element("button", "ghost-button") as HTMLButtonElement;
  button.type = "button";
  button.textContent = "载入全文";
  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "载入中…";
    void loadFullMessage(store.snapshot().selectedSessionId, address).then((loaded) => {
      // A successful load re-renders the message without this notice; a failed
      // one leaves it on screen, so the button has to become usable again.
      if (loaded) return;
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
async function loadFullMessage(sessionId: string, address: MessageAddress): Promise<boolean> {
  const key = fullTextKey(sessionId, address);
  if (loadingFullText.has(key) || fullMessageTexts.has(key)) return false;
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
    if (restored === undefined) throw new Error("消息内容已变化");
    rememberFullText(key, restored);
    // The message array is unchanged, so the cached items have to be rebuilt
    // for the restored text to reach the screen.
    transcriptState.messageSource = undefined;
    store.setNotice("载入全文：完成");
    return true;
  } catch (error) {
    store.setNotice(`载入全文失败：${toError(error).message}`);
    return false;
  } finally {
    loadingFullText.delete(key);
    render();
  }
}

function rememberFullText(key: string, value: string): void {
  fullMessageTexts.set(key, value);
  while (fullMessageTexts.size > FULL_TEXT_CACHE_ENTRIES) {
    const oldest = fullMessageTexts.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    fullMessageTexts.delete(oldest);
  }
}

function fullTextKey(sessionId: string, address: MessageAddress): string {
  return "id" in address ? `${sessionId}\u0000id:${address.id}` : `${sessionId}\u0000at:${String(address.index)}`;
}

function renderStreamingMessage(value: string, thinking: string): HTMLElement {
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
    if (!value) body.append(element("i", "stream-cursor"));
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

function renderActivities(activities: readonly DesktopActivity[]): void {
  tweenMetric(elements.activityCount, activities.length, String);
  const cards = activities.slice(-12).reverse().map((activity) => {
    const card = element("article", "activity-card");
    card.dataset["status"] = activity.status;
    const header = element("header");
    const title = element("b");
    const state = element("span", `state-dot ${activity.status}`);
    state.setAttribute("aria-label", activity.status);
    title.append(state, text(activity.label));
    const time = element("time") as HTMLTimeElement;
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
    if (lastActivitySignature && cards.length) revealListItems(cards, { distance: 6, maxStagger: 8 });
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
function renderRunActivity(snapshot: DesktopStoreSnapshot): void {
  const phase = currentRunPhase(snapshot);
  if (!phase) {
    activityPhase = undefined;
    stopActivityTicker();
    elements.runActivity.hidden = true;
    return;
  }
  if (activityPhase?.key !== phase.key) activityPhase = { key: phase.key, since: Date.now() };
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

interface RunPhase {
  /** Identity of the phase; a change restarts the elapsed clock. */
  key: string;
  kind: "approval" | "tool" | "streaming" | "thinking" | "waiting";
  label: string;
}

function currentRunPhase(snapshot: DesktopStoreSnapshot): RunPhase | undefined {
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
  if (!running) return undefined;

  const tool = snapshot.activities
    .filter((activity) => activity.status === "running" && (activity.sessionId ?? sessionId) === sessionId)
    .at(-1);
  if (tool) return { key: `tool:${tool.id}`, kind: "tool", label: `执行 ${tool.toolName ?? tool.label}` };

  if (snapshot.streamingText[sessionId]) return { key: `stream:${sessionId}`, kind: "streaming", label: "生成回复中" };
  if (snapshot.streamingThinking[sessionId]) return { key: `think:${sessionId}`, kind: "thinking", label: "思考中" };
  return { key: `wait:${sessionId}`, kind: "waiting", label: "等待模型响应" };
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds % 60} 秒`;
}

/** The elapsed count has to advance without new frames, so it drives itself. */
function startActivityTicker(): void {
  if (activityTicker !== undefined) return;
  activityTicker = window.setInterval(() => {
    if (elements.runActivity.hidden || !activityPhase) {
      stopActivityTicker();
      return;
    }
    const seconds = Math.floor((Date.now() - activityPhase.since) / 1000);
    elements.runActivityElapsed.textContent = seconds >= 2 ? `已 ${formatElapsed(seconds)}` : "";
  }, 1_000);
}

function stopActivityTicker(): void {
  if (activityTicker === undefined) return;
  window.clearInterval(activityTicker);
  activityTicker = undefined;
}

const INDEXING_PHASE_LABEL: Record<string, string> = {
  disabled: "未启用",
  unconfigured: "缺少目录",
  unavailable: "不可用",
  idle: "空闲",
  scanning: "扫描中",
  indexing: "索引中",
  failed: "失败",
};

/** Why a switched-on indexer is not making progress, in the panel's own words. */
const INDEXING_IDLE_REASON: Record<string, string> = {
  disabled: "未启用本机索引",
  unconfigured: "已启用，但还没有选择要索引的目录",
  unavailable: "已启用，但本次发行版没有可用的索引程序",
};

/**
 * Continuous indexing status. The daemon owns the work; this is a read-only
 * view so the user can tell whether a search is running against a current index.
 */
function renderIndexing(snapshot: DesktopStoreSnapshot): void {
  const indexing = snapshot.kernel.indexing;
  const phase = indexing?.phase ?? "disabled";
  elements.indexingPanel.dataset["phase"] = phase;
  elements.indexingPhase.textContent = INDEXING_PHASE_LABEL[phase] ?? phase;

  const total = indexing?.total ?? 0;
  const processed = indexing?.processed ?? 0;
  const done = phase === "idle" && total > 0;
  const percent = done ? 100 : total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  elements.indexingBarFill.style.width = `${percent}%`;
  elements.indexingBarFill.parentElement?.setAttribute("aria-valuenow", String(percent));

  const idleReason = INDEXING_IDLE_REASON[phase];
  if (idleReason !== undefined) {
    elements.indexingCounts.textContent = indexing?.message ?? idleReason;
  } else if (total > 0) {
    elements.indexingCounts.textContent =
      `${processed} / ${total} 个文件 · 跳过 ${indexing?.skipped ?? 0} · 失败 ${indexing?.failed ?? 0}`;
  } else {
    elements.indexingCounts.textContent = phase === "scanning" ? "正在扫描目录…" : "尚未开始";
  }

  elements.indexingCurrent.textContent = phase === "indexing" ? (indexing?.currentFile ?? "") : "";

  const directories = indexing?.directories ?? [];
  const notes: string[] = [];
  // The settings panel is the only place indexing is switched on, so the status
  // panel repeats that switch rather than letting the phase stand in for it.
  notes.push(indexing?.enabled ? "设置：已启用" : "设置：未启用");
  if (phase === "unconfigured") notes.push("在设置 → 本机索引中添加目录后开始索引");
  if (phase === "failed" && indexing?.message) notes.push(indexing.message);
  else if (directories.length > 0) notes.push(`索引目录：${directories.join("、")}`);
  if (phase === "idle" && indexing?.nextRunAt) notes.push(`下次检查 ${clockTime(indexing.nextRunAt)}`);
  elements.indexingNote.textContent = notes.join(" · ");
}

function renderJobs(snapshot: DesktopStoreSnapshot): void {
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

function isBuiltinTool(value: unknown): value is { name: string; label?: string; description?: string } {
  return typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string";
}

function renderIntegrations(snapshot: DesktopStoreSnapshot): void {
  const connected = snapshot.stableConnection.phase === "connected";
  const nodes: HTMLElement[] = [];
  // The fixed tools come first: they are what the agent can always do, and
  // without them the panel only ever answered "what has been added".
  if (builtinTools.length > 0) {
    const tools = element("div", "tool-chips");
    tools.setAttribute("role", "list");
    for (const tool of builtinTools) {
      const chip = element("span", "tool-chip");
      chip.setAttribute("role", "listitem");
      chip.textContent = tool.name;
      if (tool.description) chip.title = `${tool.label ?? tool.name} — ${tool.description}`;
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
    const item = denseItem(
      `未加载 Skill · ${skill.name}`,
      `${SKILL_SOURCE_LABELS[skill.source]} · ${skill.status === "shadowed" ? "同名被覆盖" : "已跳过"}`,
      "degraded",
    );
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

function renderNotifications(snapshot: DesktopStoreSnapshot): void {
  const nodes = snapshot.kernel.notifications.slice(-5).reverse().map((notification) => {
    const item = denseItem(notification.title, clockTime(notification.ts), notification.level === "error" ? "failed" : notification.level === "warning" ? "running" : "ready");
    const body = element("p");
    body.textContent = notification.body;
    item.append(body);
    return item;
  });
  elements.notificationList.replaceChildren(...(nodes.length ? nodes : [emptyList("暂无通知")]));
}

function renderApproval(snapshot: DesktopStoreSnapshot): void {
  const request = Object.values(snapshot.kernel.approvals).sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))[0];
  if (!request) {
    const previousApproval = activeApprovalId;
    activeApprovalId = undefined;
    if (elements.approvalOverlay.hidden) return;
    updateAppInert();
    const finishHide = (): void => {
      if (activeApprovalId !== undefined) return;
      elements.approvalOverlay.hidden = true;
      updateAppInert();
      requestAnimationFrame(() => elements.composerInput.focus());
    };
    if (previousApproval) hideOverlayMotion(elements.approvalOverlay, elements.approvalDialog, finishHide);
    else elements.approvalOverlay.hidden = true;
    return;
  }
  if (settingsOpen && !savingSettings) closeSettings(false);
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
    const actions: HTMLButtonElement[] = [];
    const denialScope = request.allowedScopes[0] ?? "once";
    actions.push(approvalButton("拒绝", "danger-ghost-button", request, false, denialScope));
    for (const scope of request.allowedScopes) {
      const label = scope === "once" ? "仅此一次" : scope === "session" ? "本会话允许" : "此任务允许";
      actions.push(approvalButton(label, scope === "once" ? "primary-button" : "secondary-button", request, true, scope));
    }
    elements.approvalActions.replaceChildren(...actions);
    activeApprovalId = request.id;
    if (firstPaint) showOverlayMotion(elements.approvalOverlay, elements.approvalDialog);
    requestAnimationFrame(() => actions[0]?.focus());
  }
}

function approvalButton(
  label: string,
  className: string,
  request: ApprovalRequest,
  approved: boolean,
  scope: "once" | "session" | "job",
): HTMLButtonElement {
  return actionButton(label, className, () => void perform(`${approved ? "批准" : "拒绝"} ${request.id}`, {
    action: "approval.resolve",
    approvalId: request.id,
    approved,
    scope,
  }));
}

function renderInspection(): void {
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
    if (stagingName) void perform(`安装 ${result.name}`, { action: "resources.install", stagingName, expectedDigest: result.digest }, async () => {
      inspection = undefined;
      await refreshSideData();
    });
  });
  install.disabled = !result.installable || store.snapshot().stableConnection.phase !== "connected";
  elements.inspectionResult.replaceChildren(title, digest, summary, install);
}

function renderVersions(): void {
  if (!versions) return;
  elements.versionLine.textContent = `pSpore ${versions.pspore} · Pi ${versions.pi}`;
  elements.runtimeLine.textContent = `Electron ${versions.electron} · Node ${versions.node}`;
}

function selectedAgent(snapshot: DesktopStoreSnapshot): DesktopStoreSnapshot["kernel"]["agents"][string] | undefined {
  return findSelectedAgent(snapshot.kernel, snapshot.selectedSessionId);
}

function denseItem(titleValue: string, subtitleValue: string, status: string): HTMLElement {
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

function actionButton(label: string, className: string, listener: () => void): HTMLButtonElement {
  const button = element("button", className) as HTMLButtonElement;
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", listener);
  return button;
}

function emptyList(label: string): HTMLElement {
  const empty = element("div", "empty-list");
  empty.textContent = label;
  return empty;
}

function element(tag: string, className?: string): HTMLElement {
  const result = document.createElement(tag);
  if (className) result.className = className;
  return result;
}

function text(value: string): Text {
  return document.createTextNode(value);
}

function byId<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing desktop element #${id}`);
  return value as T;
}

function bindSecretField(
  input: HTMLInputElement,
  reveal: HTMLButtonElement,
  clear: HTMLInputElement,
): void {
  reveal.addEventListener("click", () => {
    const revealing = input.type === "password";
    input.type = revealing ? "text" : "password";
    reveal.textContent = revealing ? "隐藏" : "显示";
  });
  input.addEventListener("input", () => {
    if (input.value) clear.checked = false;
  });
  clear.addEventListener("change", () => {
    if (clear.checked) input.value = "";
  });
}

function resetSecretField(
  input: HTMLInputElement,
  reveal: HTMLButtonElement,
  clear: HTMLInputElement,
  configured: boolean,
  label: string,
): void {
  input.value = "";
  input.type = "password";
  input.placeholder = configured ? "已配置；留空将保留" : `输入 ${label}`;
  reveal.textContent = "显示";
  clear.checked = false;
}

function settingsStatus(settings: DesktopLlmSettings): string {
  const key = settings.hasApiKey ? "已检测到私有 Key" : "尚未保存 API Key";
  const cookie = settings.hasCookie ? "已检测到 Cookie" : "尚未保存 Cookie";
  return `${key}；${cookie}。留空会保留当前值。`;
}

function missingElement(selector: string): never {
  throw new Error(`Missing desktop element ${selector}`);
}

function normalizedRole(role: string): "user" | "assistant" | "tool" {
  const normalized = role.toLowerCase();
  if (normalized.includes("tool")) return "tool";
  return normalized === "user" ? "user" : "assistant";
}

function safeStatus(value: string): string {
  const allowed = new Set(["ready", "active", "succeeded", "running", "connecting", "starting", "failed", "degraded", "blocked"]);
  return allowed.has(value) ? value : "unknown";
}

function initialTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // Fall through to the daylight default.
  }
  // The product default is the daylight (white & cobalt) theme.
  return "light";
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
  const nextLabel = theme === "dark" ? "切换到浅色模式" : "切换到深色模式";
  elements.themeToggle.setAttribute("aria-label", nextLabel);
  elements.themeToggle.title = nextLabel;
  elements.themeColor.content = theme === "dark" ? "#0c121b" : "#f4f7fb";
}

function friendlyConnectionMessage(message: string | undefined, phase: string): string {
  if (message?.includes("ENOENT") || message?.includes("daemon.sock")) {
    return "本地守护进程正在启动，连接就绪后会自动恢复…";
  }
  return message ?? (phase === "connecting" ? "正在连接本地守护进程…" : "守护进程已断开，正在重试…");
}

function isJobDefinition(value: unknown): value is JobDefinition {
  if (!isRecord(value) || value["version"] !== 1 || typeof value["id"] !== "string" || typeof value["enabled"] !== "boolean") return false;
  const schedule = value["schedule"];
  return isRecord(schedule) && typeof schedule["cron"] === "string" && typeof schedule["timezone"] === "string";
}

function isResourceEntry(value: unknown): value is ResourceCatalogEntry {
  if (!isRecord(value) || !isRecord(value["record"]) || !isRecord(value["health"])) return false;
  return typeof value["record"]["name"] === "string" && typeof value["record"]["digest"] === "string";
}

function isSkillCatalogEntry(value: unknown): value is SkillCatalogEntry {
  return isRecord(value)
    && typeof value["name"] === "string"
    && typeof value["path"] === "string"
    && (value["source"] === "installed" || value["source"] === "bundled" || value["source"] === "workspace")
    && (value["status"] === "active" || value["status"] === "skipped" || value["status"] === "shadowed");
}

function isInspection(value: unknown): value is StagedResourceInspection {
  return isRecord(value) && value["version"] === 1 && typeof value["name"] === "string" && typeof value["digest"] === "string" && Array.isArray(value["files"]);
}

function isSessionView(value: unknown): value is SessionView {
  return isRecord(value)
    && typeof value["sessionId"] === "string"
    && typeof value["upstreamSessionId"] === "string"
    && Array.isArray(value["messages"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
