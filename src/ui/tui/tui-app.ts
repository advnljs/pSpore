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
