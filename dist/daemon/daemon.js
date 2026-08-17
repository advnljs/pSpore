import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { AgentManager } from "../agents/agent-manager.js";
import { createAgentTools } from "../agents/agent-tools.js";
import { AgentApplication } from "../application/agent-application.js";
import { createAutomationTools } from "../automation/automation-tools.js";
import { DaemonRunExecutor } from "../automation/daemon-run-executor.js";
import { JobStore } from "../automation/job-store.js";
import { RunLedger } from "../automation/run-ledger.js";
import { Scheduler } from "../automation/scheduler.js";
import { loadConfig } from "../storage/home.js";
import { LocalGateway } from "../gateway/local-gateway.js";
import { KernelLoop } from "../kernel/loop.js";
import { PinnedContextLoader } from "../memory/context-loader.js";
import { MemoryService } from "../memory/memory-service.js";
import { createMemoryTools } from "../memory/memory-tools.js";
import { SearchService } from "../memory/search-service.js";
import { McpManager } from "../mcp/mcp-manager.js";
import { createMcpTools } from "../mcp/mcp-tools.js";
import { NotificationService } from "../notifications/notification-service.js";
import { createNotificationTools } from "../notifications/notification-tools.js";
import { PiRuntimeAdapter } from "../pi/pi-runtime-adapter.js";
import { ExtensionManager } from "../plugins/extension-manager.js";
import { ApprovalService, PolicyToolGate } from "../policy/approval-service.js";
import { PolicyEngine } from "../policy/policy.js";
import { ShellService } from "../shell/shell-service.js";
import { acquireDaemonLock, writeEndpoint } from "../storage/daemon-lock.js";
import { initializePsporeHome } from "../storage/home.js";
import { createCoreTools } from "../tools/core-tools.js";
export class PsporeDaemon {
    home;
    paths;
    instanceId;
    kernel;
    #gateway;
    #application;
    #approvals;
    #scheduler;
    #agents;
    #mcp;
    #extensions;
    #lock;
    #clock;
    #idFactory;
    #stopped;
    #resolveStopped;
    #rejectStopped;
    #stopping;
    constructor(options) {
        this.home = options.home;
        this.paths = options.paths;
        this.instanceId = options.instanceId;
        this.kernel = options.kernel;
        this.#gateway = options.gateway;
        this.#application = options.application;
        this.#approvals = options.approvals;
        this.#scheduler = options.scheduler;
        this.#agents = options.agents;
        this.#mcp = options.mcp;
        this.#extensions = options.extensions;
        this.#lock = options.lock;
        this.#clock = options.clock;
        this.#idFactory = options.idFactory;
        let resolveStopped;
        let rejectStopped;
        this.#stopped = new Promise((resolve, reject) => {
            resolveStopped = resolve;
            rejectStopped = reject;
        });
        this.#resolveStopped = resolveStopped;
        this.#rejectStopped = rejectStopped;
    }
    static async start(options) {
        const clock = options.clock ?? (() => new Date());
        const idFactory = options.idFactory ?? randomUUID;
        const initialized = await initializePsporeHome(options.home);
        const config = await loadConfig(options.home);
        const paths = initialized.paths;
        const lock = await acquireDaemonLock(paths.lock, clock());
        let gateway;
        let application;
        let approvals;
        let scheduler;
        let agents;
        let mcp;
        let extensions;
        let daemon;
        const startedAt = clock().toISOString();
        const kernel = new KernelLoop((effect) => {
            if (effect.type === "client.broadcast")
                gateway?.publish(effect.event);
        });
        try {
            const event = (input) => ({
                ...input,
                id: idFactory(),
                ts: clock().toISOString(),
            });
            const notifications = new NotificationService({
                path: join(paths.events, "notifications.jsonl"),
                recoveryDirectory: join(paths.artifacts, "recovery"),
                clock,
                idFactory,
                onNotification: async (notification) => {
                    await kernel.dispatch(event({ type: "notification.created", notification }));
                },
            });
            await notifications.initialize();
            approvals = new ApprovalService({
                pendingPath: join(paths.approvals, "pending.json"),
                grantsPath: join(paths.approvals, "job-grants.json"),
                auditPath: join(paths.audit, "approvals.jsonl"),
                timeoutMs: config.permissions.approvalTimeoutMs,
                clock,
                idFactory,
                onRequested: (request) => void kernel.dispatch(event({ type: "approval.requested", request })),
                onResolved: (request, resolution) => void kernel.dispatch(event({ type: "approval.resolved", request, resolution })),
            });
            await approvals.initialize();
            const policy = await PolicyEngine.create({
                mode: config.permissions.mode,
                rules: config.permissions.rules,
                workspaceRoot: paths.workspace,
                cwd: paths.workspace,
            });
            const toolGate = new PolicyToolGate(policy, approvals);
            extensions = await ExtensionManager.create({
                stagingRoot: join(paths.workspace, "staging"),
                skillsRoot: join(paths.workspace, "skills"),
                pluginsRoot: paths.plugins,
                trustPath: paths.resourceTrust,
                activations: config.plugins,
                clock,
                onHealth: (health) => void kernel.dispatch(event({ type: "resource.health", health })),
            });
            await extensions.startHostPlugins();
            mcp = await McpManager.create({
                configs: config.mcpServers,
                artifactRoot: paths.artifacts,
                auditPath: join(paths.audit, "mcp.jsonl"),
                clock,
                idFactory,
                onHealth: (health) => void kernel.dispatch(event({ type: "mcp.health", health })),
                onError: (error) => void markDegraded(kernel, event, error),
            });
            const shell = new ShellService({
                artifactRoot: paths.artifacts,
                ...(config.shell.executable === undefined ? {} : { configuredShell: config.shell.executable }),
            });
            await shell.initialize();
            const retrieval = new SearchService({
                workspaceRoot: paths.workspace,
                sessionsRoot: paths.sessions,
                cachePath: join(paths.cache, "index.json"),
            });
            const memory = new MemoryService({ workspaceRoot: paths.workspace, clock, idFactory });
            const coreTools = createCoreTools({
                workspaceRoot: paths.workspace,
                shell,
                defaultShellTimeoutMs: config.shell.defaultTimeoutMs,
                maxShellOutputBytes: config.shell.maxOutputBytes,
                retrieval,
                defaultSearchMaxResults: config.memory.maxResults,
                defaultSearchMaxReturnedTokens: config.memory.maxReturnedTokens,
            });
            const automationControl = () => {
                if (!scheduler)
                    throw new Error("Scheduler is not initialized");
                return scheduler;
            };
            const agentControl = () => {
                if (!agents)
                    throw new Error("Agent manager is not initialized");
                return agents;
            };
            const mcpControl = () => {
                if (!mcp)
                    throw new Error("MCP manager is not initialized");
                return mcp;
            };
            const toolsFor = (sessionId) => [
                ...coreTools,
                ...createMemoryTools(sessionId, memory),
                ...createNotificationTools(sessionId, notifications),
                ...createAutomationTools(automationControl),
                ...createAgentTools(sessionId, agentControl),
                ...createMcpTools(mcpControl),
            ];
            const tools = toolsFor("main");
            const runtime = options.runtimeFactory
                ? await options.runtimeFactory({ paths, config, toolGate, tools, skillPaths: () => extensions?.skillPaths() ?? Promise.resolve([]) })
                : await PiRuntimeAdapter.create({
                    agentDir: paths.agentDir,
                    sessionRoot: paths.sessions,
                    toolGate,
                    createTools: toolsFor,
                    createSkillPaths: () => extensions?.skillPaths() ?? [],
                });
            const context = await new PinnedContextLoader({
                workspaceRoot: paths.workspace,
                pinnedFiles: config.context.pinnedFiles,
                maxPinnedTokens: config.context.maxPinnedTokens,
            }).load();
            application = new AgentApplication({
                runtime,
                kernel,
                approvals,
                notifications,
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
                    contextFiles: context.files,
                },
                clock,
                idFactory,
                onShutdownRequested: () => setImmediate(() => void daemon?.stop()),
            });
            agents = await AgentManager.create({
                workspaceRoot: paths.workspace,
                host: application,
                maxConcurrentAgents: config.runtime.maxConcurrentAgents,
                clock,
                idFactory,
                onAgent: (agent) => void kernel.dispatch(event({ type: "agent.updated", agent })),
                onMessage: (message) => void kernel.dispatch(event({ type: "agent.message", message })),
                onError: (error) => void markDegraded(kernel, event, error),
            });
            application.setAgents(agents);
            application.setMcp(mcp);
            application.setResources(extensions);
            const ledger = new RunLedger({
                root: paths.runs,
                recoveryDirectory: join(paths.artifacts, "recovery"),
                clock,
                idFactory,
            });
            scheduler = new Scheduler({
                jobs: new JobStore({ jobsDirectory: join(paths.workspace, "jobs"), workspaceRoot: paths.workspace }),
                ledger,
                executor: new DaemonRunExecutor({
                    application,
                    shell,
                    toolGate,
                    maxShellOutputBytes: config.shell.maxOutputBytes,
                    idFactory,
                }),
                maxConcurrentRuns: config.scheduler.maxConcurrentRuns,
                clock,
                onRun: (run) => void kernel.dispatch(event({ type: "automation.run", run })),
                deliverRun: (run) => notifications.deliverRun(run),
                onError: (error) => void markDegraded(kernel, event, error),
            });
            await scheduler.initialize();
            application.setAutomation(scheduler);
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
                scheduler,
                agents,
                mcp,
                extensions,
                lock,
                clock,
                idFactory,
            });
            const resourceFailure = extensions.listHealth().find((health) => health.status === "blocked" || health.status === "degraded");
            const phase = resourceFailure ? "degraded" : "ready";
            await kernel.dispatch(event({
                type: "daemon.transition",
                daemon: {
                    phase,
                    instanceId: lock.instanceId,
                    startedAt,
                    ...(resourceFailure?.message === undefined ? {} : { error: resourceFailure.message }),
                },
            }));
            await writeEndpoint(paths.endpoint, {
                instanceId: lock.instanceId,
                socket: paths.socket,
                pid: process.pid,
                state: phase,
                startedAt,
            });
            if (config.scheduler.enabled)
                void scheduler.start().catch((error) => void markDegraded(kernel, event, error));
            if (config.boot.enabled) {
                void triggerBoot(scheduler, paths, lock.instanceId, workspaceId(paths.workspace), startedAt, clock).catch((error) => void markDegraded(kernel, event, error));
            }
            return daemon;
        }
        catch (error) {
            if (gateway)
                await gateway.stop().catch(() => undefined);
            if (scheduler)
                await scheduler.stop().catch(() => undefined);
            if (agents)
                await agents.stop().catch(() => undefined);
            if (application)
                await application.dispose().catch(() => undefined);
            if (extensions)
                await extensions.stop("daemon startup failed").catch(() => undefined);
            if (mcp)
                await mcp.stop().catch(() => undefined);
            if (approvals)
                await approvals.close().catch(() => undefined);
            await lock.release().catch(() => undefined);
            throw error;
        }
    }
    stop() {
        this.#stopping ??= this.#stop().then(() => this.#resolveStopped(), (error) => {
            const normalized = error instanceof Error ? error : new Error(String(error));
            this.#rejectStopped(normalized);
            throw normalized;
        });
        return this.#stopping;
    }
    whenStopped() {
        return this.#stopped;
    }
    async #stop() {
        let failure;
        const step = async (operation) => {
            try {
                await operation();
            }
            catch (error) {
                failure ??= error instanceof Error ? error : new Error(String(error));
            }
        };
        await step(async () => this.#transition("draining"));
        await step(async () => writeEndpoint(this.paths.endpoint, {
            instanceId: this.instanceId,
            socket: this.paths.socket,
            pid: process.pid,
            state: "draining",
            startedAt: this.kernel.snapshot().daemon.startedAt ?? this.#clock().toISOString(),
        }));
        await step(async () => this.#scheduler.stop());
        await step(async () => this.#agents.stop());
        await step(async () => this.#approvals.close());
        await step(async () => this.#application.dispose());
        await step(async () => this.#extensions.stop());
        await step(async () => this.#mcp.stop());
        await step(async () => this.#transition("stopped"));
        await step(async () => this.kernel.idle());
        await step(async () => this.#gateway.stop());
        await step(async () => unlink(this.paths.endpoint).catch((error) => {
            if (!isNodeError(error) || error.code !== "ENOENT")
                throw error;
        }));
        await step(async () => this.#lock.release());
        if (failure)
            throw failure;
    }
    async #transition(phase) {
        const previous = this.kernel.snapshot().daemon;
        await this.kernel.dispatch({
            id: this.#idFactory(),
            ts: this.#clock().toISOString(),
            type: "daemon.transition",
            daemon: { ...previous, phase },
        });
    }
}
function workspaceId(path) {
    return createHash("sha256").update(path).digest("hex").slice(0, 16);
}
async function triggerBoot(scheduler, paths, instanceId, currentWorkspaceId, startedAt, clock) {
    const content = await readFile(join(paths.workspace, "BOOT.md"), "utf8");
    const actionable = content
        .split("\n")
        .filter((line) => line.trim() && !/^\s*#/.test(line) && !/^\s*<!--/.test(line))
        .join("\n")
        .trim();
    if (!actionable)
        return;
    const trigger = {
        slotKey: `boot:${currentWorkspaceId}:${instanceId}`,
        source: "boot",
        scheduledFor: startedAt,
        receivedAt: clock().toISOString(),
        objective: "Execute the workspace BOOT.md startup checklist safely and idempotently.",
        activity: {
            kind: "agent",
            cwd: paths.workspace,
            prompt: `Execute this BOOT.md checklist. Treat it as user-authored objectives, keep operations idempotent, and report results:\n\n${actionable}`,
        },
        policyRef: "default",
        concurrency: "forbid",
        timeoutMs: 300_000,
        budget: {
            maxTurns: 8,
            maxToolCalls: 32,
            maxInputTokens: 100_000,
            maxOutputTokens: 16_000,
            maxChildren: 0,
        },
        delivery: { kind: "local-notification" },
    };
    await scheduler.trigger(trigger);
}
async function markDegraded(kernel, event, error) {
    const current = kernel.snapshot().daemon;
    if (current.phase !== "ready" && current.phase !== "degraded")
        return;
    await kernel.dispatch(event({
        type: "daemon.transition",
        daemon: { ...current, phase: "degraded", error: error instanceof Error ? error.message : String(error) },
    }));
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
//# sourceMappingURL=daemon.js.map