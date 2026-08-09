import { randomUUID } from "node:crypto";

import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";

import { ProtocolClient } from "../../protocol/client.js";
import type { ApprovalScope } from "../../policy/approval-service.js";
import { TuiStore } from "./store.js";
import { PsporeTuiView } from "./view.js";

export interface TuiAppOptions {
  socketPath: string;
  clientId?: string;
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
    });
    this.#tui.setLayoutRoot(view);
    this.#tui.setFocus(view);
    this.#tui.start();
    void this.#connect();
    try {
      await new Promise<void>((resolve) => {
        this.#resolveExit = resolve;
      });
    } finally {
      this.#stopping = true;
      if (this.#retryTimer) clearTimeout(this.#retryTimer);
      await this.#client?.close().catch(() => undefined);
      this.#tui.stop();
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
      if (input === "/abort") {
        await this.#command("session.abort", { reason: "TUI user requested abort" }, "main");
        this.#store.setNotice("Abort requested");
        return;
      }
      if (input === "/compact") {
        await this.#command("session.compact", {}, "main");
        this.#store.setNotice("Compaction requested");
        return;
      }
      if (input === "/jobs") {
        const jobs = await this.#command("jobs.list", {}) as Array<{ id: string; enabled: boolean }>;
        this.#store.setNotice(jobs.length > 0 ? jobs.map((job) => `${job.id}:${job.enabled ? "on" : "off"}`).join("  ") : "No jobs");
        return;
      }
      if (input === "/runs") {
        const runs = await this.#command("runs.list", {}) as Array<{ id: string; status: string }>;
        this.#store.setNotice(runs.length > 0 ? runs.slice(-3).map((run) => `${run.id}:${run.status}`).join("  ") : "No runs");
        return;
      }
      if (input === "/notifications") {
        const notifications = await this.#command("notifications.list", {}) as Array<{ title: string; level: string }>;
        this.#store.setNotice(
          notifications.length > 0
            ? notifications.slice(-3).map((notification) => `${notification.level}:${notification.title}`).join("  ")
            : "No notifications",
        );
        return;
      }
      if (input === "/agents") {
        const agents = await this.#command("agents.list", {}) as Array<{ id: string; status: string; depth: number }>;
        this.#store.setNotice(
          agents.length > 0
            ? agents.slice(-4).map((agent) => `${"·".repeat(agent.depth)}${agent.id}:${agent.status}`).join("  ")
            : "No child agents",
        );
        return;
      }
      if (input === "/mcp") {
        const servers = await this.#command("mcp.servers", {}) as Array<{
          serverId: string;
          status: string;
          toolCount: number;
        }>;
        this.#store.setNotice(
          servers.length > 0
            ? servers.map((server) => `${server.serverId}:${server.status}(${server.toolCount})`).join("  ")
            : "No MCP servers configured",
        );
        return;
      }
      if (input.startsWith("/mcp-discover ")) {
        const serverId = input.slice(14).trim();
        if (!serverId) throw new Error("Usage: /mcp-discover SERVER_ID");
        const tools = await this.#command("mcp.discover", { serverId }) as Array<{ normalizedName: string }>;
        this.#store.setNotice(
          tools.length > 0 ? tools.map((tool) => tool.normalizedName).join("  ") : `No allowed tools on ${serverId}`,
        );
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
      const main = this.#store.snapshot().kernel.sessions["main"];
      if (main?.status === "running") {
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
    await this.#command("session.prompt", { text, mode }, "main");
    this.#store.setNotice(`${mode} accepted`);
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
