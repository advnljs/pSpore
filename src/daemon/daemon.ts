import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { AgentApplication } from "../application/agent-application.js";
import type { PsporeConfig } from "../config/config.js";
import { loadConfig } from "../storage/home.js";
import type { AgentRuntimePort, PinnedContextFile, ToolGate } from "../domain/runtime.js";
import { LocalGateway } from "../gateway/local-gateway.js";
import { KernelLoop } from "../kernel/loop.js";
import type { KernelEvent } from "../kernel/state.js";
import { PiRuntimeAdapter } from "../pi/pi-runtime-adapter.js";
import { ApprovalService, PolicyToolGate } from "../policy/approval-service.js";
import { PolicyEngine } from "../policy/policy.js";
import { ShellService } from "../shell/shell-service.js";
import { acquireDaemonLock, writeEndpoint, type DaemonLock } from "../storage/daemon-lock.js";
import { initializePsporeHome, type PsporePaths } from "../storage/home.js";
import { createCoreTools } from "../tools/core-tools.js";

export interface DaemonRuntimeFactoryContext {
  paths: PsporePaths;
  config: PsporeConfig;
  toolGate: ToolGate;
  tools: readonly ToolDefinition[];
}

export interface StartDaemonOptions {
  home: string;
  runtimeFactory?: (context: DaemonRuntimeFactoryContext) => Promise<AgentRuntimePort>;
  clock?: () => Date;
  idFactory?: () => string;
}

type KernelEventInput = KernelEvent extends infer Event
  ? Event extends unknown
    ? Omit<Event, "id" | "ts">
    : never
  : never;

export class PsporeDaemon {
  readonly home: string;
  readonly paths: PsporePaths;
  readonly instanceId: string;
  readonly kernel: KernelLoop;
  readonly #gateway: LocalGateway;
  readonly #application: AgentApplication;
  readonly #approvals: ApprovalService;
  readonly #lock: DaemonLock;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #stopped: Promise<void>;
  readonly #resolveStopped: () => void;
  readonly #rejectStopped: (error: Error) => void;
  #stopping: Promise<void> | undefined;

  private constructor(options: {
    home: string;
    paths: PsporePaths;
    instanceId: string;
    kernel: KernelLoop;
    gateway: LocalGateway;
    application: AgentApplication;
    approvals: ApprovalService;
    lock: DaemonLock;
    clock: () => Date;
    idFactory: () => string;
  }) {
    this.home = options.home;
    this.paths = options.paths;
    this.instanceId = options.instanceId;
    this.kernel = options.kernel;
    this.#gateway = options.gateway;
    this.#application = options.application;
    this.#approvals = options.approvals;
    this.#lock = options.lock;
    this.#clock = options.clock;
    this.#idFactory = options.idFactory;
    let resolveStopped!: () => void;
    let rejectStopped!: (error: Error) => void;
    this.#stopped = new Promise<void>((resolve, reject) => {
      resolveStopped = resolve;
      rejectStopped = reject;
    });
    this.#resolveStopped = resolveStopped;
    this.#rejectStopped = rejectStopped;
  }

  static async start(options: StartDaemonOptions): Promise<PsporeDaemon> {
    const clock = options.clock ?? (() => new Date());
    const idFactory = options.idFactory ?? randomUUID;
    const initialized = await initializePsporeHome(options.home);
    const config = await loadConfig(options.home);
    const paths = initialized.paths;
    const lock = await acquireDaemonLock(paths.lock, clock());
    let gateway: LocalGateway | undefined;
    let application: AgentApplication | undefined;
    let approvals: ApprovalService | undefined;
    let daemon: PsporeDaemon | undefined;
    const startedAt = clock().toISOString();
    const kernel = new KernelLoop((effect) => {
      if (effect.type === "client.broadcast") gateway?.publish(effect.event);
    });

    try {
      const event = (input: KernelEventInput): KernelEvent => ({
        ...input,
        id: idFactory(),
        ts: clock().toISOString(),
      }) as KernelEvent;
      approvals = new ApprovalService({
        pendingPath: join(paths.approvals, "pending.json"),
        auditPath: join(paths.audit, "approvals.jsonl"),
        timeoutMs: config.permissions.approvalTimeoutMs,
        clock,
        idFactory,
        onRequested: (request) => void kernel.dispatch(event({ type: "approval.requested", request })),
        onResolved: (request, resolution) =>
          void kernel.dispatch(event({ type: "approval.resolved", request, resolution })),
      });
      await approvals.initialize();
      const policy = await PolicyEngine.create({
        mode: config.permissions.mode,
        rules: config.permissions.rules,
        workspaceRoot: paths.workspace,
        cwd: paths.workspace,
      });
      const toolGate = new PolicyToolGate(policy, approvals);
      const shell = new ShellService({
        artifactRoot: paths.artifacts,
        ...(config.shell.executable === undefined ? {} : { configuredShell: config.shell.executable }),
      });
      await shell.initialize();
      const tools = createCoreTools({
        workspaceRoot: paths.workspace,
        shell,
        defaultShellTimeoutMs: config.shell.defaultTimeoutMs,
        maxShellOutputBytes: config.shell.maxOutputBytes,
      });
      const runtime = options.runtimeFactory
        ? await options.runtimeFactory({ paths, config, toolGate, tools })
        : await PiRuntimeAdapter.create({
            agentDir: paths.agentDir,
            sessionRoot: paths.sessions,
            toolGate,
            createTools: () => tools,
          });
      const contextFiles = await readPinnedFiles(paths.workspace, config.context.pinnedFiles);
      application = new AgentApplication({
        runtime,
        kernel,
        approvals,
        modelConfigured: config.model !== null,
        sessionTemplate: {
          workspaceId: workspaceId(paths.workspace),
          cwd: paths.workspace,
          ...(config.model === null
            ? {}
            : {
                model: { provider: config.model.provider, model: config.model.model },
                thinking: config.model.thinking,
              }),
          systemPrompt: "You are pSpore, a careful local agent. Prefer read/edit/search over shell and explain side effects.",
          contextFiles,
          enabledTools: tools.map((tool) => tool.name),
        },
        clock,
        idFactory,
        onShutdownRequested: () => setImmediate(() => void daemon?.stop()),
      });
      gateway = new LocalGateway({
        socketPath: paths.socket,
        instanceId: lock.instanceId,
        snapshot: () => kernel.snapshot(),
        handleCommand: async (command) => application?.handleCommand(command),
        idFactory,
      });
      await gateway.start();
      daemon = new PsporeDaemon({
        home: options.home,
        paths,
        instanceId: lock.instanceId,
        kernel,
        gateway,
        application,
        approvals,
        lock,
        clock,
        idFactory,
      });
      await kernel.dispatch(
        event({ type: "daemon.transition", daemon: { phase: "ready", instanceId: lock.instanceId, startedAt } }),
      );
      await writeEndpoint(paths.endpoint, {
        instanceId: lock.instanceId,
        socket: paths.socket,
        pid: process.pid,
        state: "ready",
        startedAt,
      });
      return daemon;
    } catch (error) {
      if (gateway) await gateway.stop().catch(() => undefined);
      if (application) await application.dispose().catch(() => undefined);
      if (approvals) await approvals.close().catch(() => undefined);
      await lock.release().catch(() => undefined);
      throw error;
    }
  }

  stop(): Promise<void> {
    this.#stopping ??= this.#stop().then(
      () => this.#resolveStopped(),
      (error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.#rejectStopped(normalized);
        throw normalized;
      },
    );
    return this.#stopping;
  }

  whenStopped(): Promise<void> {
    return this.#stopped;
  }

  async #stop(): Promise<void> {
    let failure: Error | undefined;
    const step = async (operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
    };
    await step(async () => this.#transition("draining"));
    await step(async () =>
      writeEndpoint(this.paths.endpoint, {
        instanceId: this.instanceId,
        socket: this.paths.socket,
        pid: process.pid,
        state: "draining",
        startedAt: this.kernel.snapshot().daemon.startedAt ?? this.#clock().toISOString(),
      }),
    );
    await step(async () => this.#approvals.close());
    await step(async () => this.#application.dispose());
    await step(async () => this.#transition("stopped"));
    await step(async () => this.kernel.idle());
    await step(async () => this.#gateway.stop());
    await step(async () =>
      unlink(this.paths.endpoint).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }),
    );
    await step(async () => this.#lock.release());
    if (failure) throw failure;
  }

  async #transition(phase: "draining" | "stopped"): Promise<void> {
    const previous = this.kernel.snapshot().daemon;
    await this.kernel.dispatch({
      id: this.#idFactory(),
      ts: this.#clock().toISOString(),
      type: "daemon.transition",
      daemon: { ...previous, phase },
    });
  }
}

async function readPinnedFiles(workspace: string, names: readonly string[]): Promise<PinnedContextFile[]> {
  const files: PinnedContextFile[] = [];
  for (const name of names) {
    const path = join(workspace, name);
    try {
      files.push({ path, content: await readFile(path, "utf8") });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }
  return files;
}

function workspaceId(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
