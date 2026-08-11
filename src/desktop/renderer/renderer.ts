/// <reference lib="DOM" />

import type { JobDefinition } from "../../automation/types.js";
import type { RuntimeMessage } from "../../domain/runtime.js";
import type { ResourceCatalogEntry, StagedResourceInspection } from "../../plugins/types.js";
import type { ApprovalRequest } from "../../policy/approval-service.js";
import type { DesktopCommand, DesktopFrame, DesktopVersions } from "../ipc-contract.js";
import { DesktopStore, type DesktopActivity, type DesktopStoreSnapshot } from "./store.js";

const store = new DesktopStore();
const queuedFrames: DesktopFrame[] = [];
let initialized = false;
let versions: DesktopVersions | undefined;
let jobs: JobDefinition[] = [];
let resources: ResourceCatalogEntry[] = [];
let inspection: StagedResourceInspection | undefined;
let activeApprovalId: string | undefined;
let renderSequence = 0;

type Theme = "dark" | "light";
const THEME_STORAGE_KEY = "pspore.desktop.theme";

const elements = {
  appShell: byId<HTMLElement>("app-shell"),
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
  sessionList: byId<HTMLElement>("session-list"),
  spawnForm: byId<HTMLFormElement>("spawn-form"),
  spawnObjective: byId<HTMLTextAreaElement>("spawn-objective"),
  childControls: byId<HTMLElement>("child-controls"),
  joinAgent: byId<HTMLButtonElement>("join-agent-button"),
  cancelAgent: byId<HTMLButtonElement>("cancel-agent-button"),
  inspectForm: byId<HTMLFormElement>("inspect-form"),
  stagingName: byId<HTMLInputElement>("staging-name"),
  inspectionResult: byId<HTMLElement>("inspection-result"),
  versionLine: byId<HTMLElement>("version-line"),
  runtimeLine: byId<HTMLElement>("runtime-line"),
  sessionTitle: byId<HTMLElement>("session-title"),
  sessionStatus: byId<HTMLElement>("session-status"),
  modelName: byId<HTMLElement>("model-name"),
  transcript: byId<HTMLElement>("transcript"),
  notice: byId<HTMLElement>("notice-line"),
  composerForm: byId<HTMLFormElement>("composer-form"),
  composerInput: byId<HTMLTextAreaElement>("composer-input"),
  composerMode: byId<HTMLSelectElement>("composer-mode"),
  compact: byId<HTMLButtonElement>("compact-button"),
  abort: byId<HTMLButtonElement>("abort-button"),
  send: byId<HTMLButtonElement>("send-button"),
  activityCount: byId<HTMLElement>("activity-count"),
  activityList: byId<HTMLElement>("activity-list"),
  jobList: byId<HTMLElement>("job-list"),
  runList: byId<HTMLElement>("run-list"),
  integrationList: byId<HTMLElement>("integration-list"),
  notificationList: byId<HTMLElement>("notification-list"),
  approvalOverlay: byId<HTMLElement>("approval-overlay"),
  approvalTitle: byId<HTMLElement>("approval-title"),
  approvalSummary: byId<HTMLElement>("approval-summary"),
  approvalCapability: byId<HTMLElement>("approval-capability"),
  approvalTarget: byId<HTMLElement>("approval-target"),
  approvalReasons: byId<HTMLElement>("approval-reasons"),
  approvalCommand: byId<HTMLElement>("approval-command"),
  approvalActions: byId<HTMLElement>("approval-actions"),
};

applyTheme(initialTheme());

const unsubscribe = window.pspore.subscribe((frame) => {
  if (!initialized) queuedFrames.push(frame);
  else {
    store.applyFrame(frame);
    render();
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
    store.setNotice(`Desktop initialization failed: ${toError(error).message}`);
    render();
  } finally {
    document.documentElement.dataset["ready"] = "true";
  }
}

function bindStaticActions(): void {
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
  elements.composerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitComposer();
  });
  elements.composerInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      elements.composerForm.requestSubmit();
    }
  });
  elements.spawnForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const objective = elements.spawnObjective.value.trim();
    if (!objective) return;
    void perform("Starting child agent", { action: "agent.spawn", objective }, () => {
      elements.spawnObjective.value = "";
      return refreshSideData();
    });
  });
  elements.abort.addEventListener("click", () => {
    const snapshot = store.snapshot();
    const child = selectedAgent(snapshot);
    const command: DesktopCommand = child ? { action: "agent.cancel", agentId: child.id } : { action: "abort" };
    void perform(child ? `Cancelling ${child.id}` : "Aborting main session", command);
  });
  elements.compact.addEventListener("click", () => void perform("Compacting main context", { action: "compact" }));
  elements.joinAgent.addEventListener("click", () => {
    const child = selectedAgent(store.snapshot());
    if (child) void perform(`Waiting for ${child.id}`, { action: "agent.join", agentIds: [child.id] });
  });
  elements.cancelAgent.addEventListener("click", () => {
    const child = selectedAgent(store.snapshot());
    if (child) void perform(`Cancelling ${child.id}`, { action: "agent.cancel", agentId: child.id });
  });
  elements.inspectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const stagingName = elements.stagingName.value.trim();
    if (!stagingName) return;
    void perform("Inspecting staged resource", { action: "resources.inspect", stagingName }, (result) => {
      inspection = isInspection(result) ? result : undefined;
      renderInspection();
    });
  });
  elements.approvalOverlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = Array.from(elements.approvalActions.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    const first = buttons[0];
    const last = buttons.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

async function submitComposer(): Promise<void> {
  const text = elements.composerInput.value.trim();
  if (!text) return;
  const snapshot = store.snapshot();
  const child = selectedAgent(snapshot);
  const mode = elements.composerMode.value;
  let command: DesktopCommand;
  if (child) {
    command = {
      action: "agent.send",
      agentId: child.id,
      message: text,
      mode: mode === "steer" ? "steer" : mode === "follow_up" ? "follow_up" : "next",
    };
  } else {
    command = { action: mode === "steer" ? "steer" : mode === "follow_up" ? "follow_up" : "prompt", text };
  }
  await perform(`Sending to ${child?.id ?? "main"}`, command, () => {
    elements.composerInput.value = "";
    elements.composerInput.focus();
  });
}

async function perform(
  pendingNotice: string,
  command: DesktopCommand,
  onSuccess?: (result: unknown) => void | Promise<void>,
): Promise<void> {
  store.setNotice(`${pendingNotice}…`);
  render();
  try {
    const result = await window.pspore.dispatch(command);
    store.setNotice(`${pendingNotice}: done`);
    await onSuccess?.(result);
  } catch (error) {
    store.setNotice(`${pendingNotice}: ${toError(error).message}`);
  }
  render();
}

async function refreshSideData(): Promise<void> {
  const snapshot = store.snapshot();
  if (snapshot.connection.phase !== "connected") {
    store.setNotice("Daemon is offline; lists will refresh after reconnect");
    render();
    return;
  }
  store.setNotice("Refreshing jobs and trusted resources…");
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
  store.setNotice(failures.length ? `${failures.length} list refresh request(s) failed` : "Lists refreshed");
  render();
}

function render(): void {
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

function renderHeader(snapshot: DesktopStoreSnapshot): void {
  const connection = snapshot.connection;
  elements.connectionBadge.className = `connection-badge ${connection.phase}`;
  elements.connectionBadge.replaceChildren(element("i"), text(connection.phase === "connected" ? "ONLINE" : connection.phase.toUpperCase()));
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

function renderSessions(snapshot: DesktopStoreSnapshot): void {
  const nodes: HTMLElement[] = [];
  const mainSession = snapshot.kernel.sessions["main"];
  nodes.push(sessionButton("main", "主会话", mainSession?.status ?? "idle", 0, snapshot.selectedSessionId === "main", Boolean(mainSession) || snapshot.selectedSessionId === "main"));
  const agents = Object.values(snapshot.kernel.agents).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const agent of agents) {
    const session = snapshot.kernel.sessions[agent.sessionId];
    const title = agent.objective || agent.id;
    nodes.push(sessionButton(agent.id, title, session?.status ?? agent.status, Math.min(agent.depth, 5), snapshot.selectedSessionId === agent.sessionId, Boolean(session)));
  }
  elements.sessionList.replaceChildren(...nodes);
  elements.sessionCount.textContent = String(1 + agents.length);
  const child = selectedAgent(snapshot);
  elements.childControls.hidden = !child;
  elements.joinAgent.disabled = !child || terminalAgentStatus(child.status) || snapshot.connection.phase !== "connected";
  elements.cancelAgent.disabled = !child || terminalAgentStatus(child.status) || snapshot.connection.phase !== "connected";
}

function sessionButton(id: string, title: string, status: string, depth: number, selected: boolean, active: boolean): HTMLButtonElement {
  const button = element("button", `session-item ${status}${selected ? " selected" : ""}`) as HTMLButtonElement;
  button.type = "button";
  button.disabled = !active;
  button.style.paddingLeft = `${10 + depth * 13}px`;
  const copy = element("span", "session-copy");
  const strong = element("strong");
  strong.textContent = id === "main" ? "main" : shortId(id);
  const small = element("small");
  small.textContent = title;
  copy.append(strong, small);
  const depthMark = element("span", "depth-mark");
  depthMark.textContent = depth ? `L${depth}` : "ROOT";
  button.append(element("i", "node-dot"), copy, depthMark);
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
  elements.sessionTitle.textContent = child ? `${shortId(child.id)} · ${child.objective}` : "main";
  const status = session?.status ?? (child?.status ?? "idle");
  elements.sessionStatus.textContent = status.toUpperCase();
  elements.sessionStatus.className = `status-chip ${status}`;
  elements.modelName.textContent = session?.model ? `${session.model.provider}/${session.model.model}` : "未配置模型";
  elements.composerInput.placeholder = `向 ${child?.id ?? "main"} 发送消息…`;
  const connected = snapshot.connection.phase === "connected";
  elements.composerInput.disabled = !connected;
  elements.composerMode.disabled = !connected;
  elements.send.disabled = !connected;
  elements.abort.disabled = !connected || (!child && session?.status !== "running");
  elements.compact.disabled = !connected || Boolean(child) || !session;

  const transcript = elements.transcript;
  const pinned = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
  const messages = session?.messages ?? [];
  const content: HTMLElement[] = messages.map((message) => renderMessage(message));
  const streaming = snapshot.streamingText[snapshot.selectedSessionId];
  if (streaming) content.push(renderStreamingMessage(streaming));
  if (content.length === 0) {
    const empty = element("div", "empty-transcript");
    const inner = element("div");
    const heading = element("strong");
    heading.textContent = child ? "子 Agent 尚未产生消息" : "本地会话已就绪";
    const body = element("span");
    body.textContent = child ? "可发送 next、steer 或 follow-up 消息。" : "输入任务，或从左侧委派一个有界子任务。";
    inner.append(heading, body);
    empty.append(inner);
    content.push(empty);
  }
  transcript.replaceChildren(...content);
  if (pinned) requestAnimationFrame(() => transcript.scrollTo({ top: transcript.scrollHeight }));
}

function renderMessage(message: RuntimeMessage): HTMLElement {
  const role = normalizedRole(message.role);
  const article = element("article", `message ${role}`);
  const meta = element("div", "message-meta");
  const label = element("span");
  label.textContent = role === "assistant" ? "pSpore" : role;
  meta.append(element("i", "role-dot"), label);
  if (role === "tool") {
    const details = element("details");
    const summary = element("summary");
    summary.textContent = `Tool output · ${formatBytes(new TextEncoder().encode(message.text).byteLength)} · click to expand`;
    const pre = element("pre");
    pre.textContent = message.text || "(empty output)";
    details.append(summary, pre);
    article.append(meta, details);
  } else {
    const body = element("div", "message-body");
    appendRichText(body, message.text || "(empty message)");
    article.append(meta, body);
  }
  return article;
}

function renderStreamingMessage(value: string): HTMLElement {
  const article = element("article", "message assistant streaming");
  const meta = element("div", "message-meta");
  const label = element("span");
  label.textContent = "pSpore · streaming";
  meta.append(element("i", "role-dot"), label);
  const body = element("div", "message-body");
  body.append(text(value), element("i", "stream-cursor"));
  article.append(meta, body);
  return article;
}

function appendRichText(container: HTMLElement, value: string): void {
  const expression = /```(?:[^\n]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of value.matchAll(expression)) {
    const index = match.index;
    if (index > cursor) container.append(text(value.slice(cursor, index)));
    const pre = element("pre");
    pre.textContent = match[1] ?? "";
    container.append(pre);
    cursor = index + match[0].length;
  }
  if (cursor < value.length) container.append(text(value.slice(cursor)));
}

function renderActivities(activities: readonly DesktopActivity[]): void {
  elements.activityCount.textContent = String(activities.length);
  const cards = activities.slice(-12).reverse().map((activity) => {
    const card = element("article", "activity-card");
    const header = element("header");
    const title = element("b");
    title.textContent = activity.summary;
    const time = element("time") as HTMLTimeElement;
    time.textContent = clockTime(activity.ts);
    time.dateTime = activity.ts;
    header.append(title, time);
    card.append(header);
    if (activity.sessionId) {
      const session = element("p");
      session.textContent = `session ${shortId(activity.sessionId)}`;
      card.append(session);
    }
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

function renderJobs(snapshot: DesktopStoreSnapshot): void {
  const connected = snapshot.connection.phase === "connected";
  const jobNodes = jobs.slice(0, 4).map((job) => {
    const item = denseItem(job.id, job.enabled ? `${job.schedule.cron} · ${job.schedule.timezone}` : "disabled", job.enabled ? "ready" : "disabled");
    const actions = element("div", "item-actions");
    const run = actionButton("立即运行", "ghost-button", () => void perform(`Running ${job.id}`, { action: "job.run", jobId: job.id }));
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
      const cancel = actionButton("取消运行", "danger-ghost-button", () => void perform(`Cancelling ${run.id}`, { action: "run.cancel", runId: run.id }));
      cancel.disabled = !connected;
      actions.append(cancel);
      item.append(actions);
    }
    return item;
  });
  elements.runList.replaceChildren(...(runNodes.length ? runNodes : [emptyList("暂无运行记录")]));
}

function renderIntegrations(snapshot: DesktopStoreSnapshot): void {
  const connected = snapshot.connection.phase === "connected";
  const nodes: HTMLElement[] = [];
  for (const health of Object.values(snapshot.kernel.mcpServers)) {
    const item = denseItem(`MCP · ${health.serverId}`, `${health.status} · ${health.toolCount} tools`, health.status);
    const actions = element("div", "item-actions");
    const discover = actionButton("发现工具", "ghost-button", () => void perform(`Discovering ${health.serverId}`, { action: "mcp.discover", serverId: health.serverId }));
    const ping = actionButton("Ping", "ghost-button", () => void perform(`Pinging ${health.serverId}`, { action: "mcp.ping", serverId: health.serverId }));
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
      const disable = actionButton("撤销信任", "danger-ghost-button", () => void perform(`Disabling ${health.name}`, {
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
    elements.approvalOverlay.hidden = true;
    elements.appShell.inert = false;
    elements.appShell.removeAttribute("aria-hidden");
    activeApprovalId = undefined;
    if (previousApproval) requestAnimationFrame(() => elements.composerInput.focus());
    return;
  }
  elements.approvalOverlay.hidden = false;
  elements.appShell.inert = true;
  elements.appShell.setAttribute("aria-hidden", "true");
  elements.approvalTitle.textContent = request.display.summary;
  elements.approvalSummary.textContent = `Agent ${request.agentPath.join(" → ")} 请求执行受保护操作。批准范围会被守护进程记录并强制执行。`;
  elements.approvalCapability.textContent = request.capability;
  elements.approvalTarget.textContent = request.canonicalTarget ?? request.display.cwd ?? "未指定";
  elements.approvalReasons.textContent = request.riskReasons.join("；") || "策略要求确认";
  elements.approvalCommand.hidden = !request.display.command;
  elements.approvalCommand.textContent = request.display.command ?? "";
  const actions: HTMLButtonElement[] = [];
  const denialScope = request.allowedScopes[0] ?? "once";
  actions.push(approvalButton("拒绝", "danger-ghost-button", request, false, denialScope));
  for (const scope of request.allowedScopes) {
    const label = scope === "once" ? "仅此一次" : scope === "session" ? "本会话允许" : "此任务允许";
    actions.push(approvalButton(label, scope === "once" ? "primary-button" : "secondary-button", request, true, scope));
  }
  elements.approvalActions.replaceChildren(...actions);
  if (activeApprovalId !== request.id) {
    activeApprovalId = request.id;
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
  return actionButton(label, className, () => void perform(`${approved ? "Approving" : "Denying"} ${request.id}`, {
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
  summary.textContent = `${result.files.length} files · ${formatBytes(result.totalBytes)}${result.diagnostics.length ? ` · ${result.diagnostics.join("; ")}` : ""}`;
  const install = actionButton(result.installable ? "信任并安装精确内容" : "不可安装", "secondary-button", () => {
    const stagingName = elements.stagingName.value.trim();
    if (stagingName) void perform(`Installing ${result.name}`, { action: "resources.install", stagingName, expectedDigest: result.digest }, async () => {
      inspection = undefined;
      await refreshSideData();
    });
  });
  install.disabled = !result.installable || store.snapshot().connection.phase !== "connected";
  elements.inspectionResult.replaceChildren(title, digest, summary, install);
}

function renderVersions(): void {
  if (!versions) return;
  elements.versionLine.textContent = `pSpore ${versions.pspore} · Pi ${versions.pi}`;
  elements.runtimeLine.textContent = `Electron ${versions.electron} · Node ${versions.node}`;
}

function selectedAgent(snapshot: DesktopStoreSnapshot): DesktopStoreSnapshot["kernel"]["agents"][string] | undefined {
  return Object.values(snapshot.kernel.agents).find((agent) => agent.sessionId === snapshot.selectedSessionId);
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

function normalizedRole(role: string): "user" | "assistant" | "tool" {
  const normalized = role.toLowerCase();
  if (normalized.includes("tool")) return "tool";
  return normalized === "user" ? "user" : "assistant";
}

function safeStatus(value: string): string {
  const allowed = new Set(["ready", "active", "succeeded", "running", "connecting", "starting", "failed", "degraded", "blocked"]);
  return allowed.has(value) ? value : "unknown";
}

function terminalAgentStatus(value: string): boolean {
  return value === "succeeded" || value === "failed" || value === "cancelled" || value === "budget_exhausted";
}

function shortId(value: string): string {
  return value.length > 15 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
}

function formatTokens(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

function formatBytes(value: number): string {
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
  if (value >= 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${value} B`;
}

function clockTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value.slice(0, 8) : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function initialTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // Fall through to the operating-system preference.
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
  const nextLabel = theme === "dark" ? "切换到浅色模式" : "切换到深色模式";
  elements.themeToggle.setAttribute("aria-label", nextLabel);
  elements.themeToggle.title = nextLabel;
  elements.themeColor.content = theme === "dark" ? "#0d100e" : "#f2f2ec";
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

function isInspection(value: unknown): value is StagedResourceInspection {
  return isRecord(value) && value["version"] === 1 && typeof value["name"] === "string" && typeof value["digest"] === "string" && Array.isArray(value["files"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
