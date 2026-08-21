import { randomUUID } from "node:crypto";

import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";

import { ProtocolClient } from "../../protocol/client.js";
import type { ApprovalScope } from "../../policy/approval-service.js";
import type { PermissionMode } from "../../config/config.js";
import {
  BYPASS_PERMISSION_MODE,
  decodeLlmSettingsUpdate,
  defaultModelFor,
  MODEL_APIS,
  PERMISSION_MODES,
  permissionModeSummary,
  PROVIDER_OPTIONS,
  THINKING_LEVELS,
  type LlmSettings,
  type LlmSettingsUpdate,
  type ModelApi,
  type ProviderOption,
  type ThinkingLevel,
} from "../../settings/llm-settings.js";
import { TuiStore } from "./store.js";
import { TUI_HELP_LINES } from "./commands.js";
import { PsporeTuiView } from "./view.js";
import { activityDetailLines } from "../shared/activity.js";
import { conversationIntent, selectedAgent } from "../shared/presentation.js";

export interface TuiSettingsPort {
  get(): Promise<LlmSettings>;
  save(update: LlmSettingsUpdate): Promise<LlmSettings>;
  isModelConfigured?(): Promise<boolean>;
}

export const MODEL_SETUP_OFFER_PROMPT = "Run the model setup wizard now? [Y/n]";

export const MODEL_SETUP_OFFER_LINES = [
  "No model is configured yet, so prompts would fail with model_not_configured.",
  "",
  "The wizard walks through provider, model, thinking, API key and optional proxy cookie.",
  "The key and cookie are stored in private 0600 files and are never shown in the TUI.",
  "",
  "Answer n to skip; you can run /config wizard at any time.",
];

/** Empty input accepts the recommendation; only an explicit no declines. */
export function acceptsModelSetupOffer(answer: string | undefined): boolean {
  if (answer === undefined) return false;
  const normalized = answer.trim().toLowerCase();
  return normalized === "" || normalized === "y" || normalized === "yes";
}

export interface TuiAppOptions {
  socketPath: string;
  clientId?: string;
  settings?: TuiSettingsPort;
  onSettingsSaved?: () => Promise<{ applied: boolean; restartRequired: boolean; message: string }>;
}

export class PsporeTuiApp {
  readonly #options: TuiAppOptions;
  readonly #store = new TuiStore();
  readonly #terminal = new ProcessTerminal();
  readonly #tui = new TuiAltScreen(this.#terminal, true);
  readonly #clientId: string;
  #client: ProtocolClient | undefined;
  #stopping = false;
  #retryTimer: NodeJS.Timeout | undefined;
  #retryMs = 250;
  #lastInterruptAt = 0;
  #resolveExit: (() => void) | undefined;
  #view: PsporeTuiView | undefined;

  constructor(options: TuiAppOptions) {
    this.#options = options;
    this.#clientId = options.clientId ?? `tui-${randomUUID()}`;
  }

  async run(): Promise<void> {
    const view = new PsporeTuiView({
      state: () => this.#store.snapshot(),
      height: () => this.#terminal.rows,
      requestRender: () => this.#tui.requestRender(),
      onSubmit: (input) => void this.#submit(input),
      onInterrupt: () => void this.#interrupt(),
      onBack: () => this.#store.clearPanel(),
    });
    this.#view = view;
    this.#tui.setLayoutRoot(view);
    this.#tui.setFocus(view);
    this.#tui.start();
    void this.#connect();
    void this.#refreshConfiguredModel();
    void this.#offerModelSetup();
    try {
      await new Promise<void>((resolve) => {
        this.#resolveExit = resolve;
      });
    } finally {
      this.#stopping = true;
      if (this.#retryTimer) clearTimeout(this.#retryTimer);
      await this.#client?.close().catch(() => undefined);
      this.#view?.dispose();
      this.#tui.stop();
      this.#view = undefined;
      await this.#terminal.drainInput(250, 25);
    }
  }

  async #connect(): Promise<void> {
    if (this.#stopping) return;
    const client = new ProtocolClient({
      socketPath: this.#options.socketPath,
      clientId: this.#clientId,
      capabilities: ["tui", "approval"],
      cursors: { ...this.#store.snapshot().cursors },
    });
    this.#client = client;
    client.subscribe((event) => {
      this.#store.applyEvent(event);
      if (this.#store.snapshot().gap) {
        void client.close();
      }
      this.#tui.requestRender();
    });
    client.subscribeConnection((connected, error) => {
      if (connected) return;
      this.#store.disconnected(error?.message ?? "Disconnected");
      this.#tui.requestRender();
      this.#scheduleReconnect();
    });
    try {
      const hello = await client.connect();
      if (this.#client !== client) {
        await client.close();
        return;
      }
      this.#store.applyHello(hello);
      this.#retryMs = 250;
      this.#tui.requestRender(true);
    } catch (error) {
      this.#store.disconnected(`Daemon unavailable: ${toError(error).message}`);
      this.#tui.requestRender();
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopping || this.#retryTimer) return;
    const delay = this.#retryMs;
    this.#retryMs = Math.min(this.#retryMs * 2, 5_000);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#connect();
    }, delay);
    this.#retryTimer.unref();
  }

  async #submit(input: string): Promise<void> {
    try {
      if (input === "/quit") {
        this.#exit();
        return;
      }
      if (input === "/help") {
        this.#store.setPanel("Command palette", TUI_HELP_LINES);
        return;
      }
      if (input === "/work" || input.startsWith("/work ")) {
        this.#showWork(input.slice(5).trim());
        return;
      }
      if (input === "/back") {
        this.#store.clearPanel();
        return;
      }
      if (input === "/config" || input.startsWith("/config ")) {
        await this.#config(input);
        return;
      }
      if (input === "/abort") {
        const child = this.#selectedAgent();
        if (child) await this.#command("agent.cancel", { agentId: child.id, reason: "cancelled from TUI" });
        else await this.#command("session.abort", { reason: "TUI user requested abort" }, "main");
        this.#store.setNotice(child ? `Agent ${child.id} cancelled` : "Abort requested");
        return;
      }
      if (input === "/compact") {
        if (this.#selectedAgent()) throw new Error("Compaction is available only for the main session");
        await this.#command("session.compact", {}, "main");
        this.#store.setNotice("Compaction requested");
        return;
      }
      if (input === "/jobs") {
        const jobs = await this.#command("jobs.list", {}) as Array<{ id: string; enabled: boolean; schedule?: { cron?: string; timezone?: string } }>;
        this.#store.setPanel("Automation jobs", jobs.map((job) => (
          `• ${job.id} · ${job.enabled ? "enabled" : "disabled"}${job.schedule?.cron ? ` · ${job.schedule.cron} ${job.schedule.timezone ?? ""}` : ""}`
        )));
        return;
      }
      if (input === "/runs") {
        const runs = await this.#command("runs.list", {}) as Array<{ id: string; jobId?: string; status: string; reason?: string; error?: string }>;
        this.#store.setPanel("Automation runs", runs.slice().reverse().map((run) => (
          `• ${run.id} · ${run.jobId ?? "manual"} · ${run.status}${run.reason ? ` · ${run.reason}` : run.error ? ` · ${run.error}` : ""}`
        )));
        return;
      }
      if (input === "/notifications") {
        const notifications = await this.#command("notifications.list", {}) as Array<{ title: string; level: string; body?: string }>;
        this.#store.setPanel("Notifications", notifications.slice().reverse().map((notification) => (
          `• ${notification.level.toUpperCase()} · ${notification.title}${notification.body ? ` — ${notification.body}` : ""}`
        )));
        return;
      }
      if (input === "/agents") {
        const agents = await this.#command("agents.list", {}) as Array<{ id: string; status: string; depth: number; objective?: string }>;
        this.#store.setPanel("Agent tree", agents.map((agent) => (
          `${"  ".repeat(agent.depth)}${agent.depth > 0 ? "↳" : "•"} ${agent.id} · ${agent.status}${agent.objective ? ` · ${agent.objective}` : ""}`
        )));
        return;
      }
      if (input === "/mcp") {
        const servers = await this.#command("mcp.servers", {}) as Array<{
          serverId: string;
          status: string;
          toolCount: number;
        }>;
        this.#store.setPanel("MCP servers", servers.map((server) => (
          `• ${server.serverId} · ${server.status} · ${server.toolCount} tools`
        )));
        return;
      }
      if (input === "/mcp-tools") {
        const tools = await this.#command("mcp.tools", {}) as Array<{ normalizedName: string; description?: string }>;
        this.#store.setPanel("MCP tools", tools.map((tool) => `• ${tool.normalizedName}${tool.description ? ` — ${tool.description}` : ""}`));
        return;
      }
      if (input.startsWith("/mcp-discover ")) {
        const serverId = input.slice(14).trim();
        if (!serverId) throw new Error("Usage: /mcp-discover SERVER_ID");
        const tools = await this.#command("mcp.discover", { serverId }) as Array<{ normalizedName: string }>;
        this.#store.setPanel(`MCP tools · ${serverId}`, tools.map((tool) => `• ${tool.normalizedName}`));
        return;
      }
      if (input.startsWith("/mcp-ping ")) {
        const serverId = input.slice(10).trim();
        if (!serverId) throw new Error("Usage: /mcp-ping SERVER_ID");
        const server = await this.#command("mcp.ping", { serverId }) as { serverId: string; status: string; toolCount: number; error?: string };
        this.#store.setPanel(`MCP ping · ${serverId}`, [
          `status  ${server.status}`,
          `tools   ${server.toolCount}`,
          ...(server.error ? [`error   ${server.error}`] : []),
        ]);
        return;
      }
      if (input === "/resources" || input === "/skills" || input === "/plugins") {
        const command = input === "/skills" ? "skills.list" : input === "/plugins" ? "plugins.list" : "resources.list";
        const resources = await this.#command(command, {}) as Array<{
          record: { kind: string; name: string };
          health: { status: string };
        }>;
        this.#store.setPanel(input === "/skills" ? "Skills" : input === "/plugins" ? "Host plugins" : "Trusted resources", resources.map((resource) => (
          `• ${resource.record.kind} · ${resource.record.name} · ${resource.health.status}`
        )));
        return;
      }
      if (input.startsWith("/resource-inspect ")) {
        const stagingPath = input.slice(18).trim();
        if (!stagingPath) throw new Error("Usage: /resource-inspect STAGING_PATH");
        const inspected = await this.#command("resources.inspect", { stagingPath }) as {
          kind: string;
          name: string;
          digest: string;
          installable: boolean;
        };
        this.#store.setNotice(`${inspected.kind}:${inspected.name} ${inspected.installable ? "installable" : "blocked"} sha256:${inspected.digest}`);
        return;
      }
      if (input.startsWith("/resource-install ")) {
        const parts = input.slice(18).trim().split(/\s+/);
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          throw new Error("Usage: /resource-install STAGING_PATH SHA256");
        }
        const installed = await this.#command("resources.install", {
          stagingPath: parts[0],
          expectedDigest: parts[1],
        }) as { record: { kind: string; name: string }; health: { status: string } };
        this.#store.setNotice(`Installed ${installed.record.kind}:${installed.record.name} (${installed.health.status})`);
        return;
      }
      if (input.startsWith("/resource-disable ")) {
        const parts = input.slice(18).trim().split(/\s+/);
        if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
          throw new Error("Usage: /resource-disable KIND NAME SHA256");
        }
        const disabled = await this.#command("resources.disable", {
          kind: parts[0],
          name: parts[1],
          expectedDigest: parts[2],
        }) as { record: { kind: string; name: string }; health: { status: string } };
        this.#store.setNotice(`Disabled ${disabled.record.kind}:${disabled.record.name} (${disabled.health.status})`);
        return;
      }
      if (input.startsWith("/select ")) {
        const selected = this.#store.selectSession(input.slice(8).trim());
        this.#store.setNotice(`Selected session ${selected}`);
        return;
      }
      if (input.startsWith("/agent-spawn ")) {
        const objective = input.slice(13).trim();
        if (!objective) throw new Error("Usage: /agent-spawn OBJECTIVE");
        const agent = await this.#command("agent.spawn", {
          parentId: "main",
          objective,
          workspaceMode: "shared-read",
          budget: {
            maxTurns: 8,
            maxToolCalls: 24,
            maxInputTokens: 50_000,
            maxOutputTokens: 8_000,
            maxChildren: 0,
          },
        }) as { id: string; status: string };
        this.#store.setNotice(`Agent ${agent.id}: ${agent.status}`);
        return;
      }
      if (input.startsWith("/agent-join ")) {
        const agentIds = input.slice(12).trim().split(/\s+/).filter(Boolean);
        if (agentIds.length === 0) throw new Error("Usage: /agent-join AGENT_ID...");
        const agents = await this.#command("agent.join", { agentIds, timeoutMs: 300_000 }) as Array<{
          id: string;
          status: string;
        }>;
        this.#store.setNotice(agents.map((agent) => `${agent.id}:${agent.status}`).join("  "));
        return;
      }
      if (input.startsWith("/agent-cancel ")) {
        const agent = await this.#command("agent.cancel", { agentId: input.slice(14).trim() }) as {
          id: string;
          status: string;
        };
        this.#store.setNotice(`Agent ${agent.id}: ${agent.status}`);
        return;
      }
      if (input.startsWith("/agent ")) {
        const separator = input.indexOf(" ", 7);
        if (separator < 0) throw new Error("Usage: /agent AGENT_ID MESSAGE");
        const agentId = input.slice(7, separator).trim();
        const message = input.slice(separator + 1).trim();
        if (!agentId || !message) throw new Error("Usage: /agent AGENT_ID MESSAGE");
        await this.#command("agent.send", { agentId, message, mode: "next" });
        this.#store.setNotice(`Message queued for ${agentId}`);
        return;
      }
      if (input.startsWith("/run ")) {
        const run = await this.#command("job.run", { jobId: input.slice(5).trim() }) as { id: string; status: string };
        this.#store.setNotice(`Run ${run.id}: ${run.status}`);
        return;
      }
      if (input.startsWith("/cancel ")) {
        const run = await this.#command("run.cancel", { runId: input.slice(8).trim() }) as { id: string; status: string };
        this.#store.setNotice(`Run ${run.id}: ${run.status}`);
        return;
      }
      if (input.startsWith("/steer ")) {
        await this.#prompt(input.slice(7), "steer");
        return;
      }
      if (input.startsWith("/follow ")) {
        await this.#prompt(input.slice(8), "follow_up");
        return;
      }
      if (input.startsWith("/approve") || input.startsWith("/deny")) {
        await this.#approval(input);
        return;
      }
      const child = this.#selectedAgent();
      const main = this.#store.snapshot().kernel.sessions["main"];
      if (!child && main?.status === "running") {
        this.#store.setNotice("Session is running; use /steer TEXT or /follow TEXT explicitly");
        return;
      }
      await this.#prompt(input, "prompt");
    } catch (error) {
      this.#store.setNotice(`Error: ${toError(error).message}`);
    } finally {
      this.#tui.requestRender();
    }
  }

  async #prompt(text: string, mode: "prompt" | "steer" | "follow_up"): Promise<void> {
    const snapshot = this.#store.snapshot();
    const intent = conversationIntent(snapshot.kernel, snapshot.selectedSessionId, text, mode);
    if (intent.target === "agent") {
      await this.#command("agent.send", {
        agentId: intent.agentId,
        message: intent.text,
        mode: intent.mode,
      });
      this.#store.setNotice(`${intent.mode} queued for ${intent.agentId}`);
      return;
    }
    await this.#command("session.prompt", { text: intent.text, mode: intent.mode }, intent.sessionId);
    this.#store.setNotice(`${mode} accepted for main`);
  }

  async #approval(input: string): Promise<void> {
    const parts = input.split(/\s+/);
    const approved = parts[0] === "/approve";
    const pending = Object.values(this.#store.snapshot().kernel.approvals);
    const approvalId = parts[1] ?? (pending.length === 1 ? pending[0]?.id : undefined);
    if (!approvalId) throw new Error("Specify an approval ID");
    const scope = (parts[2] ?? "once") as ApprovalScope;
    if (!(["once", "session", "job"] as const).includes(scope)) throw new Error("Approval scope must be once, session, or job");
    const result = await this.#command("approval.resolve", { approvalId, approved, scope }) as { status: string };
    if (result.status !== "resolved") throw new Error(`Approval was not resolved: ${result.status}`);
    this.#store.setNotice(approved ? "Approval granted" : "Approval denied");
  }

  async #config(input: string): Promise<void> {
    const settings = this.#options.settings;
    if (!settings) throw new Error("Model settings are unavailable in this TUI session");
    const parts = input.trim().split(/\s+/);
    const action = parts[1] ?? "show";
    if (action === "show") {
      if (parts.length > 2) throw new Error("Usage: /config show");
      this.#showSettings(await settings.get());
      return;
    }
    if (action === "wizard") {
      if (parts.length > 2) throw new Error("Usage: /config wizard");
      await this.#settingsWizard();
      return;
    }
    const current = await settings.get();
    if (action === "set") {
      const provider = parseProvider(parts[2]);
      if (provider === "custom-openai") {
        const model = parts[3];
        const baseUrl = parts[4];
        if (!model || !baseUrl) {
          throw new Error("Usage: /config set custom-openai MODEL BASE_URL [chat|responses] [THINKING]");
        }
        const api = parseOpenAiApi(parts[5] ?? "chat");
        const thinking = parseThinking(parts[6] ?? current.thinking);
        await this.#saveSettings(updateFrom(current, { provider, model, baseUrl, api, thinking, customModel: true }));
        return;
      }
      const model = parts[3] ?? defaultModelFor(provider);
      const thinking = parseThinking(parts[4] ?? current.thinking);
      if (parts.length > 5) throw new Error("Usage: /config set PROVIDER [MODEL] [THINKING]");
      await this.#saveSettings(updateFrom(current, {
        provider,
        model,
        thinking,
        baseUrl: "",
        api: "provider-default",
        customModel: false,
      }));
      return;
    }
    if (action === "provider") {
      const provider = parseProvider(parts[2]);
      if (provider === "custom-openai") throw new Error("Use /config endpoint BASE_URL [chat|responses] for custom-openai");
      if (parts.length !== 3) throw new Error("Usage: /config provider deepseek|openai");
      await this.#saveSettings(updateFrom(current, {
        provider,
        model: defaultModelFor(provider),
        baseUrl: "",
        api: "provider-default",
        customModel: false,
      }));
      return;
    }
    if (action === "model") {
      const model = parts[2];
      if (!model || parts.length !== 3) throw new Error("Usage: /config model MODEL");
      await this.#saveSettings(updateFrom(current, { model }));
      return;
    }
    if (action === "endpoint") {
      const baseUrl = parts[2];
      if (!baseUrl || parts.length > 4) throw new Error("Usage: /config endpoint BASE_URL [chat|responses]");
      await this.#saveSettings(updateFrom(current, {
        provider: "custom-openai",
        model: current.provider === "custom-openai" ? current.model : defaultModelFor("custom-openai"),
        baseUrl,
        api: parseOpenAiApi(parts[3] ?? "chat"),
        customModel: true,
      }));
      return;
    }
    if (action === "thinking") {
      if (parts.length !== 3) throw new Error(`Usage: /config thinking ${THINKING_LEVELS.join("|")}`);
      await this.#saveSettings(updateFrom(current, { thinking: parseThinking(parts[2]) }));
      return;
    }
    if (action === "permissions") {
      if (parts.length !== 3) throw new Error(`Usage: /config permissions ${PERMISSION_MODES.join("|")}|bypass`);
      const permissionMode = parsePermissionMode(parts[2]);
      await this.#saveSettings(updateFrom(current, { permissionMode }));
      if (permissionMode === BYPASS_PERMISSION_MODE) {
        this.#store.setNotice("Permissions bypassed: tools now run with your own privileges and no confirmation");
      }
      return;
    }
    if (action === "key") {
      if (parts.length !== 2) throw new Error("API keys are never accepted as command arguments; use /config key");
      const apiKey = await this.#view?.requestValue("API key (hidden; Esc cancels)", { secret: true });
      if (apiKey === undefined) {
        this.#store.setNotice("API key update cancelled");
        return;
      }
      if (!apiKey) throw new Error("API key cannot be empty");
      await this.#saveSettings(updateFrom(current, { apiKey }));
      return;
    }
    if (action === "clear-key") {
      if (parts.length !== 2) throw new Error("Usage: /config clear-key");
      await this.#saveSettings(updateFrom(current, { clearApiKey: true }));
      return;
    }
    if (action === "cookie") {
      if (parts.length !== 2) throw new Error("Cookies are never accepted as command arguments; use /config cookie");
      const cookie = await this.#view?.requestValue("Cookie (hidden; Esc cancels)", { secret: true });
      if (cookie === undefined) {
        this.#store.setNotice("Cookie update cancelled");
        return;
      }
      if (!cookie) throw new Error("Cookie cannot be empty");
      await this.#saveSettings(updateFrom(current, { cookie }));
      return;
    }
    if (action === "clear-cookie") {
      if (parts.length !== 2) throw new Error("Usage: /config clear-cookie");
      await this.#saveSettings(updateFrom(current, { clearCookie: true }));
      return;
    }
    throw new Error("Unknown config action; use /config, /config wizard, or /help");
  }

  /**
   * First-run recommendation: offer the wizard when no model is configured, but never
   * force it — declining leaves the session usable for status, jobs and resource commands.
   */
  async #offerModelSetup(): Promise<void> {
    const settingsPort = this.#options.settings;
    const view = this.#view;
    if (!settingsPort?.isModelConfigured || !view) return;
    try {
      if (await settingsPort.isModelConfigured()) return;
      if (this.#stopping) return;
      this.#store.setPanel("Model setup recommended", [...MODEL_SETUP_OFFER_LINES]);
      const answer = await view.requestValue(MODEL_SETUP_OFFER_PROMPT);
      if (!acceptsModelSetupOffer(answer)) {
        this.#store.clearPanel();
        this.#store.setNotice("Skipped model setup; run /config wizard when you are ready");
        return;
      }
      await this.#settingsWizard();
    } catch (error) {
      this.#store.clearPanel();
      this.#store.setNotice(`Model setup unavailable: ${toError(error).message}`);
    } finally {
      // Nothing else drives a repaint here: this runs from run(), not from #submit.
      this.#tui.requestRender();
    }
  }

  async #settingsWizard(): Promise<void> {
    const settingsPort = this.#options.settings;
    const view = this.#view;
    if (!settingsPort || !view) throw new Error("Settings wizard is unavailable");
    const current = await settingsPort.get();
    this.#showWizardStep(1, "Choose a provider", [
      `1  DeepSeek      ${current.provider === "deepseek" ? "← current" : ""}`,
      `2  OpenAI        ${current.provider === "openai" ? "← current" : ""}`,
      `3  Custom OpenAI ${current.provider === "custom-openai" ? "← current" : ""}`,
    ]);
    const providerValue = await view.requestValue(`1/7 provider [${current.provider}] (1 deepseek · 2 openai · 3 custom)`);
    if (providerValue === undefined) return this.#cancelWizard();
    const provider = providerValue.trim() ? parseProvider(providerValue) : current.provider;
    const suggestedModel = provider === current.provider ? current.model : defaultModelFor(provider);
    this.#showWizardStep(2, "Choose a model", [
      `Provider   ${provider}`,
      `Suggested  ${suggestedModel}`,
      "Press Enter to accept the suggestion, or type another model ID.",
    ]);
    const modelValue = await view.requestValue(`2/7 model [${suggestedModel}]`);
    if (modelValue === undefined) return this.#cancelWizard();
    const model = modelValue.trim() || suggestedModel;
    let baseUrl = "";
    let api: ModelApi = "provider-default";
    if (provider === "custom-openai") {
      this.#showWizardStep(3, "Connect an OpenAI-compatible endpoint", [
        `Current URL  ${current.provider === provider ? current.baseUrl || "not set" : "not set"}`,
        "The URL must use HTTP(S) and cannot contain credentials.",
        "API compatibility can be Chat Completions or Responses.",
      ]);
      const baseUrlValue = await view.requestValue(`3/7 Base URL [${current.provider === provider ? current.baseUrl : "required"}]`);
      if (baseUrlValue === undefined) return this.#cancelWizard();
      baseUrl = baseUrlValue.trim() || (current.provider === provider ? current.baseUrl : "");
      if (!baseUrl) throw new Error("A Base URL is required for custom OpenAI");
      const apiValue = await view.requestValue("3/7 API [chat] (chat · responses)");
      if (apiValue === undefined) return this.#cancelWizard();
      api = parseOpenAiApi(apiValue.trim() || (current.provider === provider ? current.api : "chat"));
    }
    this.#showWizardStep(4, "Choose thinking effort", [
      `Current   ${current.thinking}`,
      `Options   ${THINKING_LEVELS.join(" · ")}`,
      "Higher effort can increase latency and token use when the provider supports it.",
    ]);
    const thinkingValue = await view.requestValue(`4/7 thinking [${current.thinking}] (${THINKING_LEVELS.join(" · ")})`);
    if (thinkingValue === undefined) return this.#cancelWizard();
    const thinking = parseThinking(thinkingValue.trim() || current.thinking);
    this.#showWizardStep(5, "Manage the API key", [
      `Status   ${current.hasApiKey ? "configured (hidden)" : "not configured"}`,
      "keep    Leave the managed key unchanged",
      "set     Enter a new key through hidden input",
      "clear   Remove the managed key",
    ]);
    const keyActionValue = await view.requestValue(`5/7 key [keep] (keep · set · clear)`);
    if (keyActionValue === undefined) return this.#cancelWizard();
    const keyAction = keyActionValue.trim().toLowerCase() || "keep";
    if (!(["keep", "set", "clear"] as const).includes(keyAction as "keep" | "set" | "clear")) {
      throw new Error("Key action must be keep, set, or clear");
    }
    let apiKey: string | undefined;
    if (keyAction === "set") {
      apiKey = await view.requestValue("5/7 API key (hidden; Esc cancels)", { secret: true });
      if (apiKey === undefined) return this.#cancelWizard();
      if (!apiKey) throw new Error("API key cannot be empty");
    }
    this.#showWizardStep(6, "Optional LLM proxy cookie", [
      `Status   ${current.hasCookie ? "configured (hidden)" : "not configured"}`,
      "keep    Leave the managed cookie unchanged",
      "set     Enter a Cookie header through hidden input",
      "clear   Remove the managed cookie",
    ]);
    const cookieActionValue = await view.requestValue(`6/7 cookie [keep] (keep · set · clear)`);
    if (cookieActionValue === undefined) return this.#cancelWizard();
    const cookieAction = cookieActionValue.trim().toLowerCase() || "keep";
    if (!(["keep", "set", "clear"] as const).includes(cookieAction as "keep" | "set" | "clear")) {
      throw new Error("Cookie action must be keep, set, or clear");
    }
    let cookie: string | undefined;
    if (cookieAction === "set") {
      cookie = await view.requestValue("6/7 Cookie (hidden; Esc cancels)", { secret: true });
      if (cookie === undefined) return this.#cancelWizard();
      if (!cookie) throw new Error("Cookie cannot be empty");
    }
    this.#showWizardStep(7, "Review and apply", [
      `Provider   ${provider}`,
      `Model      ${model}`,
      `Base URL   ${baseUrl || "provider default"}`,
      `API        ${api}`,
      `Thinking   ${thinking}`,
      `API key    ${keyAction === "keep" ? current.hasApiKey ? "keep configured key" : "not configured" : keyAction}`,
      `Cookie     ${cookieAction === "keep" ? current.hasCookie ? "keep configured cookie" : "not configured" : cookieAction}`,
      "",
      "The key and cookie values are never displayed or stored in the TUI state.",
    ]);
    const confirmation = await view.requestValue("7/7 save and apply? [y/N]");
    if (confirmation === undefined || !/^(y|yes)$/i.test(confirmation.trim())) return this.#cancelWizard();
    await this.#saveSettings(updateFrom(current, {
      provider,
      model,
      baseUrl,
      api,
      thinking,
      customModel: provider === "custom-openai",
      ...(apiKey ? { apiKey } : {}),
      ...(cookie ? { cookie } : {}),
      clearApiKey: keyAction === "clear",
      clearCookie: cookieAction === "clear",
    }));
  }

  async #saveSettings(update: LlmSettingsUpdate): Promise<void> {
    const settingsPort = this.#options.settings;
    if (!settingsPort) throw new Error("Model settings are unavailable");
    this.#store.setNotice("Validating model settings…");
    const saved = await settingsPort.save(decodeLlmSettingsUpdate(update, "TUI LLM settings"));
    this.#store.setConfiguredModel({ provider: saved.provider, model: saved.model });
    const applied = await this.#options.onSettingsSaved?.();
    this.#showSettings(saved, applied?.message ?? "Settings saved; restart the daemon to apply them");
  }

  #showSettings(settings: LlmSettings, message = "Model settings"): void {
    this.#store.setPanel("Model settings", settingsLines(settings));
    this.#store.setNotice(message);
  }

  #showWizardStep(step: number, title: string, lines: readonly string[]): void {
    const progress = Array.from({ length: 7 }, (_, index) => index + 1 < step ? "●" : index + 1 === step ? "◉" : "○").join("─");
    this.#store.setPanel(`Model setup · ${step}/7`, [
      `${progress}  ${title}`,
      "",
      ...lines,
      "",
      "Esc cancels without saving.",
    ]);
  }

  #showWork(query: string): void {
    const activities = this.#store.snapshot().activities;
    if (!query) {
      this.#store.setPanel("Work history", activities.length === 0
        ? ["No work steps have been recorded in this daemon session yet."]
        : activities.slice(-30).map((activity) => {
            const status = activity.status === "running" ? "RUN" : activity.status === "failed" ? "FAIL" : "DONE";
            const result = activity.resultSummary ? ` · ${activity.resultSummary}` : "";
            return `${status.padEnd(4)} ${activity.id.slice(0, 8)} · ${activity.label} · ${activity.summary}${result}`;
          }));
      return;
    }
    const matches = activities.filter((activity) => activity.id === query || activity.id.startsWith(query));
    if (matches.length === 0) throw new Error(`No work step matches ${query}`);
    if (matches.length > 1) throw new Error(`Work step ID is ambiguous: ${query}`);
    const activity = matches[0];
    if (!activity) throw new Error(`No work step matches ${query}`);
    this.#store.setPanel(`Work step ${activity.id.slice(0, 8)}`, activityDetailLines(activity));
  }

  async #refreshConfiguredModel(): Promise<void> {
    const settings = this.#options.settings;
    if (!settings) return;
    try {
      const configured = settings.isModelConfigured ? await settings.isModelConfigured() : true;
      if (!configured || this.#stopping) {
        this.#store.setConfiguredModel(undefined);
        return;
      }
      const value = await settings.get();
      if (!this.#stopping) this.#store.setConfiguredModel({ provider: value.provider, model: value.model });
    } catch {
      // The settings panel reports actionable errors on demand; header refresh stays non-blocking.
    } finally {
      if (!this.#stopping) this.#tui.requestRender();
    }
  }

  #cancelWizard(): void {
    this.#store.clearPanel();
    this.#store.setNotice("Settings wizard cancelled; nothing was changed");
  }

  #selectedAgent() {
    const snapshot = this.#store.snapshot();
    return selectedAgent(snapshot.kernel, snapshot.selectedSessionId);
  }

  async #command(type: string, payload: unknown, sessionId?: string): Promise<unknown> {
    const client = this.#client;
    if (!client?.hello) throw new Error("Daemon is not connected");
    return client.command(type, payload, sessionId === undefined ? {} : { sessionId });
  }

  async #interrupt(): Promise<void> {
    const running = this.#store.snapshot().kernel.sessions["main"]?.status === "running";
    if (running) {
      await this.#submit("/abort");
      this.#lastInterruptAt = Date.now();
      return;
    }
    const now = Date.now();
    if (now - this.#lastInterruptAt < 1_500) {
      this.#exit();
    } else {
      this.#lastInterruptAt = now;
      this.#store.setNotice("Press Ctrl+C again to exit cleanly");
      this.#tui.requestRender();
    }
  }

  #exit(): void {
    this.#stopping = true;
    this.#resolveExit?.();
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function parseProvider(value: string | undefined): ProviderOption {
  const normalized = value?.trim().toLowerCase();
  const aliases: Readonly<Record<string, ProviderOption>> = {
    "1": "deepseek",
    deepseek: "deepseek",
    "2": "openai",
    openai: "openai",
    "3": "custom-openai",
    custom: "custom-openai",
    "custom-openai": "custom-openai",
  };
  const provider = normalized ? aliases[normalized] : undefined;
  if (!provider || !PROVIDER_OPTIONS.includes(provider)) {
    throw new Error("Provider must be deepseek, openai, or custom-openai");
  }
  return provider;
}

function parsePermissionMode(value: string | undefined): PermissionMode {
  const normalized = value?.trim().toLowerCase();
  // `bypass` is the name users reach for; it maps onto the existing allow_all policy.
  const mode = normalized === "bypass" ? "allow_all" : normalized;
  if (!mode || !PERMISSION_MODES.includes(mode as PermissionMode)) {
    throw new Error(`Permission mode must be one of: ${PERMISSION_MODES.join(", ")} (or bypass)`);
  }
  return mode as PermissionMode;
}

function parseThinking(value: string | undefined): ThinkingLevel {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !THINKING_LEVELS.includes(normalized as ThinkingLevel)) {
    throw new Error(`Thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  return normalized as ThinkingLevel;
}

function parseOpenAiApi(value: string): Extract<ModelApi, "openai-completions" | "openai-responses"> {
  const normalized = value.trim().toLowerCase();
  const api = normalized === "chat" ? "openai-completions" : normalized === "responses" ? "openai-responses" : normalized;
  if (!MODEL_APIS.includes(api as ModelApi) || (api !== "openai-completions" && api !== "openai-responses")) {
    throw new Error("Custom OpenAI API must be chat/openai-completions or responses/openai-responses");
  }
  return api;
}

function updateFrom(settings: LlmSettings, changes: Partial<LlmSettingsUpdate>): LlmSettingsUpdate {
  return {
    provider: changes.provider ?? settings.provider,
    model: changes.model ?? settings.model,
    baseUrl: changes.baseUrl ?? settings.baseUrl,
    api: changes.api ?? settings.api,
    thinking: changes.thinking ?? settings.thinking,
    customModel: changes.customModel ?? settings.customModel,
    permissionMode: changes.permissionMode ?? settings.permissionMode,
    ...(changes.apiKey ? { apiKey: changes.apiKey } : {}),
    ...(changes.cookie ? { cookie: changes.cookie } : {}),
    clearApiKey: changes.clearApiKey ?? false,
    clearCookie: changes.clearCookie ?? false,
  };
}

function settingsLines(settings: LlmSettings): string[] {
  return [
    `Provider   ${settings.provider}`,
    `Model      ${settings.model}`,
    `Base URL   ${settings.baseUrl || "provider default"}`,
    `API        ${settings.api}`,
    `Thinking   ${settings.thinking}`,
    `Approvals  ${settings.permissionMode} — ${permissionModeSummary(settings.permissionMode)}`,
    `API key    ${settings.hasApiKey ? "configured (hidden)" : "not configured"}`,
    `Cookie     ${settings.hasCookie ? "configured (hidden)" : "not configured"}`,
    "",
    "Use /config wizard for guided setup, or /help for direct commands.",
  ];
}
