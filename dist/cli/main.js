#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PsporeDaemon } from "../daemon/daemon.js";
import { ProtocolClient } from "../protocol/client.js";
import { readResourceTrustSummary } from "../plugins/extension-manager.js";
import { resolvePsporeHome } from "../config/config.js";
import { ShellService } from "../shell/shell-service.js";
import { stopLegacyDaemon } from "../service/legacy-daemon.js";
import { serviceLaunchSpec } from "../service/service-launch.js";
import { SystemServiceManager } from "../service/system-service.js";
import { LlmSettingsService } from "../settings/llm-settings-service.js";
import {} from "../config/config.js";
import { defaultModelFor, MODEL_APIS, PERMISSION_MODES, permissionModeSummary, PROVIDER_OPTIONS, THINKING_LEVELS, } from "../settings/llm-settings.js";
import { initializePsporeHome, loadConfig, psporePaths } from "../storage/home.js";
import { acceptsModelSetupOffer, PsporeTuiApp } from "../ui/tui/tui-app.js";
import { PI_VERSION, PSPORE_VERSION } from "../version.js";
const execFileAsync = promisify(execFile);
/**
 * Both npm bin aliases point at this file; echo back whichever one the user typed.
 * Declared above the top-level entrypoint call so it is initialized before `runCli` runs.
 */
const BIN_ALIASES = new Set(["pspore", "p-spore"]);
const DEFAULT_BIN_ALIAS = "pspore";
export async function runCli(argv = process.argv.slice(2)) {
    const parsed = parseGlobalOptions(argv);
    const home = resolvePsporeHome(parsed.home);
    const command = parsed.args[0] ?? "help";
    const args = parsed.args.slice(1);
    switch (command) {
        case "help":
        case "--help":
        case "-h":
            // A bare invocation is the first thing a new user runs, so offer setup there.
            return runHelp(home, parsed.args.length === 0);
        case "setup":
            requireNoArgs(args, "setup");
            return runSetupWizard(home);
        case "version":
        case "--version":
        case "-v":
            process.stdout.write(`pSpore ${PSPORE_VERSION} (Pi ${PI_VERSION}, Node ${process.versions.node})\n`);
            return 0;
        case "init": {
            requireNoArgs(args, "init");
            const result = await initializePsporeHome(home);
            process.stdout.write(result.created.length > 0
                ? `Initialized pSpore home at ${home}\nCreated ${result.created.length} files.\n`
                : `pSpore home is already initialized at ${home}; no files overwritten.\n`);
            return 0;
        }
        case "daemon":
            requireNoArgs(args, "daemon");
            return runDaemon(home);
        case "service":
            return runServiceCommand(home, args);
        case "status":
            requireNoArgs(args, "status");
            return printStatus(home);
        case "doctor":
            requireNoArgs(args, "doctor");
            return doctor(home);
        case "tui":
            requireNoArgs(args, "tui");
            return runTui(home);
        case "desktop":
            requireNoArgs(args, "desktop");
            return runDesktop(home);
        case "config":
            return runConfigCommand(home, args);
        case "jobs":
            requireNoArgs(args, "jobs");
            return printProtocolList(home, "jobs.list");
        case "runs":
            requireNoArgs(args, "runs");
            return printProtocolList(home, "runs.list");
        case "notifications":
            requireNoArgs(args, "notifications");
            return printProtocolList(home, "notifications.list");
        case "agents":
            requireNoArgs(args, "agents");
            return printProtocolList(home, "agents.list");
        case "sessions":
            requireNoArgs(args, "sessions");
            return printSessions(home);
        case "session":
            return runSessionCommand(home, args);
        case "agent":
            return runAgentCommand(home, args);
        case "mcp":
            return runMcpCommand(home, args);
        case "resources":
            requireNoArgs(args, "resources");
            return printResourceList(home, "resources.list");
        case "skills":
            requireNoArgs(args, "skills");
            return printResourceList(home, "skills.list");
        case "plugins":
            requireNoArgs(args, "plugins");
            return printResourceList(home, "plugins.list");
        case "resource":
            return runResourceCommand(home, args);
        case "schedule":
            if (args.length !== 2 || args[0] !== "put")
                throw new CliError("schedule usage: schedule put JOB.json");
            return putJobFile(home, args[1]);
        case "run":
            if (args.length !== 1)
                throw new CliError("run requires exactly one job ID");
            return runJob(home, args[0]);
        case "cancel":
            if (args.length !== 1)
                throw new CliError("cancel requires exactly one run ID");
            return cancelRun(home, args[0]);
        case "prompt":
            return runPromptCommand(home, args);
        default:
            throw new CliError(`Unknown command: ${command}\n\n${helpText()}`);
    }
}
async function runDaemon(home) {
    const daemon = await PsporeDaemon.start({ home });
    process.stdout.write(`pSpore service process ${daemon.kernel.snapshot().daemon.phase} (PID ${process.pid})\nSocket: ${daemon.paths.socket}\n`);
    let stopping = false;
    const stop = () => {
        if (stopping)
            return;
        stopping = true;
        void daemon.stop().catch(() => undefined);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
        await daemon.whenStopped();
        return 0;
    }
    finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
    }
}
async function printStatus(home) {
    const client = await connectFromEndpoint(home, "status");
    try {
        const status = await client.command("status.get", {});
        const sessionCount = Object.keys(status.sessions).length;
        const active = Object.values(status.sessions).filter((session) => session.status === "running").length;
        process.stdout.write([
            `Daemon: ${status.daemon.phase}`,
            `Instance: ${status.daemon.instanceId ?? "unknown"}`,
            `Revision: ${status.revision}`,
            `Sessions: ${sessionCount} (${active} running)`,
            `Pending approvals: ${Object.keys(status.approvals).length}`,
            `Runs: ${Object.keys(status.runs).length} (${Object.values(status.runs).filter((run) => run.status === "running").length} running)`,
            `MCP servers: ${Object.keys(status.mcpServers).length} (${Object.values(status.mcpServers).filter((server) => server.status === "ready").length} ready)`,
            `Resources: ${Object.keys(status.resources).length} (${Object.values(status.resources).filter((resource) => resource.status === "active" || resource.status === "ready").length} active)`,
        ].join("\n") + "\n");
        return 0;
    }
    finally {
        await client.close();
    }
}
async function doctor(home) {
    const checks = [];
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    checks.push({ name: "Node", ok: nodeMajor === 24, detail: process.versions.node });
    try {
        const config = await loadConfig(home);
        checks.push({ name: "Config", ok: true, detail: `${home}/config.json` });
        checks.push({
            name: "Model",
            ok: config.model !== null,
            detail: config.model ? `${config.model.provider}/${config.model.model}` : "not configured",
        });
        checks.push({
            name: "MCP config",
            ok: true,
            detail: `${config.mcpServers.length} configured (${config.mcpServers.filter((server) => server.enabled).length} enabled)`,
        });
        const resourceTrust = await readResourceTrustSummary(psporePaths(home, config.runtime.workspace).resourceTrust);
        checks.push({
            name: "Resource trust",
            ok: true,
            detail: `${resourceTrust.trusted} trusted, ${resourceTrust.disabled} disabled (${resourceTrust.skills} skills, ${resourceTrust.hostPlugins} host plugins)`,
        });
        const shell = new ShellService({
            artifactRoot: psporePaths(home, config.runtime.workspace).artifacts,
            ...(config.shell.executable === undefined ? {} : { configuredShell: config.shell.executable }),
        });
        const resolved = await shell.initialize();
        checks.push({ name: "Shell", ok: true, detail: `${resolved.path} (${resolved.source})` });
    }
    catch (error) {
        checks.push({ name: "Config", ok: false, detail: toError(error).message });
    }
    try {
        const result = await execFileAsync("rg", ["--version"], { encoding: "utf8" });
        checks.push({ name: "ripgrep", ok: true, detail: result.stdout.split("\n")[0] ?? "available" });
    }
    catch (error) {
        checks.push({ name: "ripgrep", ok: false, detail: toError(error).message });
    }
    try {
        const endpoint = await endpointFor(home);
        const client = new ProtocolClient({ socketPath: endpoint.socket, clientId: "doctor" });
        await client.connect();
        await client.close();
        checks.push({ name: "Daemon", ok: true, detail: `${endpoint.state} at ${endpoint.socket}` });
    }
    catch (error) {
        checks.push({ name: "Daemon", ok: false, detail: toError(error).message });
    }
    for (const check of checks)
        process.stdout.write(`${check.ok ? "OK" : "FAIL"}  ${check.name}: ${check.detail}\n`);
    return checks.every((check) => check.ok || check.name === "Model" || check.name === "Daemon") ? 0 : 1;
}
async function runTui(home) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new CliError(`tui requires an interactive TTY; use \`${resolveInvokedName(process.argv[1])} status\` for a non-interactive check`);
    }
    const { paths } = await initializePsporeHome(home);
    const service = await cliSystemService(home, paths.workspace);
    const ensured = await service.manager.ensureRunning(service.spec);
    if (ensured.lingerWarning)
        process.stderr.write(`pSpore service warning: ${ensured.lingerWarning}\n`);
    const settings = new LlmSettingsService(home, paths);
    await new PsporeTuiApp({
        socketPath: paths.socket,
        settings,
        onSettingsSaved: async () => {
            await service.manager.restart();
            return { applied: true, restartRequired: false, message: "Settings saved; the system service is restarting" };
        },
    }).run();
    return 0;
}
async function runServiceCommand(home, args) {
    const action = args[0] ?? "status";
    const { paths } = await initializePsporeHome(home);
    const service = await cliSystemService(home, paths.workspace);
    if (action === "install" || action === "start") {
        requireNoArgs(args.slice(1), `service ${action}`);
        const status = await service.manager.ensureRunning(service.spec);
        process.stdout.write(serviceStatusText(status));
        if (status.lingerWarning)
            process.stderr.write(`Warning: ${status.lingerWarning}\n`);
        return 0;
    }
    if (action === "restart") {
        requireNoArgs(args.slice(1), "service restart");
        if (!(await service.manager.status()).installed)
            await service.manager.ensureRunning(service.spec);
        else
            await service.manager.restart();
        process.stdout.write(serviceStatusText(await service.manager.status()));
        return 0;
    }
    if (action === "stop") {
        requireNoArgs(args.slice(1), "service stop");
        await service.manager.stop();
        process.stdout.write(serviceStatusText(await service.manager.status()));
        return 0;
    }
    if (action === "uninstall") {
        requireNoArgs(args.slice(1), "service uninstall");
        await service.manager.uninstall();
        process.stdout.write(`Removed ${service.manager.unitName}\n`);
        return 0;
    }
    if (action === "logs") {
        if (args.length > 2)
            throw new CliError("service logs accepts an optional line count");
        const lines = args[1] === undefined ? 100 : Number(args[1]);
        process.stdout.write(await service.manager.logs(lines));
        return 0;
    }
    if (action === "status") {
        requireNoArgs(args.slice(1), "service status");
        process.stdout.write(serviceStatusText(await service.manager.status()));
        return 0;
    }
    throw new CliError("service usage: service install|start|restart|stop|status|logs [LINES]|uninstall");
}
async function cliSystemService(home, workspace) {
    const manager = new SystemServiceManager({ home, beforeStart: async () => stopLegacyDaemon(home) });
    const spec = await serviceLaunchSpec(home, workspace, {
        execPath: process.execPath,
        ...(process.argv[1] === undefined ? {} : { argvEntry: process.argv[1] }),
        moduleUrl: import.meta.url,
    });
    return { manager, spec };
}
function serviceStatusText(status) {
    return [
        `Service: ${status.unitName}`,
        `Unit: ${status.unitPath}`,
        `Installed: ${status.installed ? "yes" : "no"}`,
        `Enabled: ${status.enabled ? "yes" : "no"}`,
        `Active: ${status.active ? "yes" : "no"}`,
        `Boot without login: ${status.linger === undefined ? "unknown" : status.linger ? "yes" : "no"}`,
    ].join("\n") + "\n";
}
async function runDesktop(home) {
    const entry = fileURLToPath(new URL("../desktop/main.js", import.meta.url));
    try {
        await access(entry);
    }
    catch {
        throw new CliError(`Electron entry is not built at ${entry}; run \`npm run build\` first`);
    }
    const require = createRequire(import.meta.url);
    let electron;
    try {
        electron = require("electron");
    }
    catch {
        throw new CliError("Electron is not included in the npm CLI package; use the pSpore desktop zip from GitHub Releases");
    }
    if (typeof electron !== "string")
        throw new CliError("The local Electron executable could not be resolved");
    return new Promise((resolve, reject) => {
        const child = spawn(electron, [entry, "--home", home], { stdio: "inherit", env: process.env });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (signal)
                reject(new CliError(`Electron exited after signal ${signal}`));
            else
                resolve(code ?? 1);
        });
    });
}
/** True when nothing usable is configured yet, including a home that does not exist. */
async function modelNeedsSetup(home) {
    const paths = psporePaths(home);
    try {
        await access(paths.config);
    }
    catch {
        return true;
    }
    return !(await new LlmSettingsService(home, paths).isModelConfigured());
}
async function runHelp(home, offerSetup) {
    // Never let a settings problem hide the help text.
    const needsSetup = await modelNeedsSetup(home).catch(() => false);
    if (!needsSetup) {
        process.stdout.write(helpText());
        return 0;
    }
    const cli = resolveInvokedName(process.argv[1]);
    process.stdout.write(`No model is configured yet, so prompts would fail with model_not_configured.\n`
        + `Run \`${cli} setup\` for guided setup, or \`${cli} config set ...\` to configure it directly.\n\n`);
    if (!offerSetup || !process.stdin.isTTY || !process.stdout.isTTY) {
        process.stdout.write(helpText());
        return 0;
    }
    const answer = await readLineInput("Run the model setup wizard now? [Y/n] ");
    if (!acceptsModelSetupOffer(answer)) {
        process.stdout.write(`\nSkipped. Run \`${cli} setup\` whenever you are ready.\n\n`);
        process.stdout.write(helpText());
        return 0;
    }
    return runSetupWizard(home);
}
async function runSetupWizard(home) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new CliError(`setup requires an interactive TTY; use \`${resolveInvokedName(process.argv[1])} config set ...\` instead`);
    }
    const { paths } = await initializePsporeHome(home);
    const service = new LlmSettingsService(home, paths);
    const current = await service.get();
    process.stdout.write("\nModel setup — press Enter to accept each default, Ctrl+C to abort.\n\n");
    const providerAnswer = await readLineInput(`1/6 provider [${current.provider}] (deepseek · openai · custom-openai): `);
    const provider = providerAnswer.trim() ? parseConfigProvider(providerAnswer.trim()) : current.provider;
    const suggestedModel = provider === current.provider ? current.model : defaultModelFor(provider);
    const modelAnswer = await readLineInput(`2/6 model [${suggestedModel}]: `);
    const model = modelAnswer.trim() || suggestedModel;
    let baseUrl = "";
    let api = "provider-default";
    if (provider === "custom-openai") {
        const suggestedUrl = current.provider === provider ? current.baseUrl : "";
        const urlAnswer = await readLineInput(`3/6 Base URL${suggestedUrl ? ` [${suggestedUrl}]` : " (required)"}: `);
        baseUrl = urlAnswer.trim() || suggestedUrl;
        if (!baseUrl)
            throw new CliError("A Base URL is required for custom OpenAI");
        const apiAnswer = await readLineInput("3/6 API [chat] (chat · responses): ");
        api = parseConfigApi(apiAnswer.trim() || "chat");
    }
    const thinkingAnswer = await readLineInput(`4/6 thinking [${current.thinking}] (${THINKING_LEVELS.join(" · ")}): `);
    const thinking = parseConfigThinking(thinkingAnswer.trim() || current.thinking);
    const keyDefault = current.hasApiKey ? "keep" : "set";
    const keyAnswer = await readLineInput(`5/6 API key [${keyDefault}] (set · keep · clear): `);
    const keyAction = (keyAnswer.trim().toLowerCase() || keyDefault);
    if (!["set", "keep", "clear"].includes(keyAction))
        throw new CliError("Key action must be set, keep, or clear");
    let apiKey;
    if (keyAction === "set") {
        apiKey = await readSecretInput("API key");
        if (!apiKey)
            throw new CliError("API key cannot be empty");
    }
    const cookieDefault = current.hasCookie ? "keep" : "skip";
    const cookieAnswer = await readLineInput(`6/6 Cookie [${cookieDefault}] (set · keep · clear · skip): `);
    const cookieAction = (cookieAnswer.trim().toLowerCase() || cookieDefault);
    if (!["set", "keep", "clear", "skip"].includes(cookieAction))
        throw new CliError("Cookie action must be set, keep, clear, or skip");
    let cookie;
    if (cookieAction === "set") {
        cookie = await readSecretInput("Cookie");
        if (!cookie)
            throw new CliError("Cookie cannot be empty");
    }
    const saved = await service.save(settingsUpdate(current, {
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
    process.stdout.write("\n");
    printModelSettings(saved);
    const cli = resolveInvokedName(process.argv[1]);
    process.stdout.write(saved.hasApiKey
        ? `\nSaved. Start the agent with \`${cli} tui\`.\n`
        : `\nSaved, but no API key is configured yet; add one with \`${cli} config key\`.\n`);
    return 0;
}
async function runConfigCommand(home, args) {
    if (args[0] === "wizard") {
        requireNoArgs(args.slice(1), "config wizard");
        return runSetupWizard(home);
    }
    const { paths } = await initializePsporeHome(home);
    const service = new LlmSettingsService(home, paths);
    const action = args[0] ?? "show";
    if (action === "show") {
        if (args.length > 1)
            throw new CliError("config show does not accept arguments");
        printModelSettings(await service.get());
        return 0;
    }
    const current = await service.get();
    let update;
    if (action === "set") {
        const provider = parseConfigProvider(args[1]);
        if (provider === "custom-openai") {
            const model = args[2];
            const baseUrl = args[3];
            if (!model || !baseUrl || args.length > 6) {
                throw new CliError("config set usage: config set custom-openai MODEL BASE_URL [chat|responses] [THINKING]");
            }
            update = settingsUpdate(current, {
                provider,
                model,
                baseUrl,
                api: parseConfigApi(args[4] ?? "chat"),
                thinking: parseConfigThinking(args[5] ?? current.thinking),
                customModel: true,
            });
        }
        else {
            if (args.length > 4)
                throw new CliError("config set usage: config set PROVIDER [MODEL] [THINKING]");
            update = settingsUpdate(current, {
                provider,
                model: args[2] ?? defaultModelFor(provider),
                thinking: parseConfigThinking(args[3] ?? current.thinking),
                baseUrl: "",
                api: "provider-default",
                customModel: false,
            });
        }
    }
    else if (action === "provider") {
        const provider = parseConfigProvider(args[1]);
        if (provider === "custom-openai")
            throw new CliError("Use `config endpoint BASE_URL` to select custom-openai");
        if (args.length !== 2)
            throw new CliError("config provider usage: config provider deepseek|openai");
        update = settingsUpdate(current, {
            provider,
            model: defaultModelFor(provider),
            baseUrl: "",
            api: "provider-default",
            customModel: false,
        });
    }
    else if (action === "model") {
        const model = args[1];
        if (!model || args.length !== 2)
            throw new CliError("config model requires exactly one MODEL");
        update = settingsUpdate(current, { model });
    }
    else if (action === "endpoint") {
        const baseUrl = args[1];
        if (!baseUrl || args.length > 3)
            throw new CliError("config endpoint usage: config endpoint BASE_URL [chat|responses]");
        update = settingsUpdate(current, {
            provider: "custom-openai",
            model: current.provider === "custom-openai" ? current.model : defaultModelFor("custom-openai"),
            baseUrl,
            api: parseConfigApi(args[2] ?? "chat"),
            customModel: true,
        });
    }
    else if (action === "thinking") {
        if (args.length !== 2)
            throw new CliError(`config thinking usage: config thinking ${THINKING_LEVELS.join("|")}`);
        update = settingsUpdate(current, { thinking: parseConfigThinking(args[1]) });
    }
    else if (action === "permissions") {
        if (args.length !== 2) {
            throw new CliError(`config permissions usage: config permissions ${PERMISSION_MODES.join("|")}|bypass`);
        }
        update = settingsUpdate(current, { permissionMode: parsePermissionMode(args[1]) });
    }
    else if (action === "key") {
        if (args.length !== 1)
            throw new CliError("API keys are never accepted as command arguments; use `config key` and enter it securely");
        const apiKey = await readSecretInput("API key");
        if (!apiKey)
            throw new CliError("API key cannot be empty");
        update = settingsUpdate(current, { apiKey });
    }
    else if (action === "clear-key") {
        if (args.length !== 1)
            throw new CliError("config clear-key does not accept arguments");
        update = settingsUpdate(current, { clearApiKey: true });
    }
    else if (action === "cookie") {
        if (args.length !== 1)
            throw new CliError("Cookies are never accepted as command arguments; use `config cookie` and enter it securely");
        const cookie = await readSecretInput("Cookie");
        if (!cookie)
            throw new CliError("Cookie cannot be empty");
        update = settingsUpdate(current, { cookie });
    }
    else if (action === "clear-cookie") {
        if (args.length !== 1)
            throw new CliError("config clear-cookie does not accept arguments");
        update = settingsUpdate(current, { clearCookie: true });
    }
    else {
        throw new CliError("config usage: show | set | provider | model | endpoint | thinking | permissions | key | clear-key | cookie | clear-cookie");
    }
    const saved = await service.save(update);
    printModelSettings(saved);
    process.stdout.write("Saved. Restart an existing daemon to apply the new model settings.\n");
    return 0;
}
function printModelSettings(settings) {
    process.stdout.write([
        `Provider: ${settings.provider}`,
        `Model: ${settings.model}`,
        `Base URL: ${settings.baseUrl || "provider default"}`,
        `API: ${settings.api}`,
        `Thinking: ${settings.thinking}`,
        `Permissions: ${settings.permissionMode} — ${permissionModeSummary(settings.permissionMode)}`,
        `API key: ${settings.hasApiKey ? "configured (hidden)" : "not configured"}`,
        `Cookie: ${settings.hasCookie ? "configured (hidden)" : "not configured"}`,
    ].join("\n") + "\n");
}
/** Visible single-line prompt; secrets must go through readSecretInput instead. */
async function readLineInput(prompt) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        return await rl.question(prompt);
    }
    finally {
        rl.close();
    }
}
async function readSecretInput(label = "API key") {
    if (!process.stdin.isTTY) {
        let value = "";
        for await (const chunk of process.stdin) {
            value += String(chunk);
            if (value.length > 16_386)
                throw new CliError(`${label} input exceeds 16384 characters`);
        }
        return value.replace(/\r?\n$/, "");
    }
    process.stdout.write(`${label} (hidden): `);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return new Promise((resolve, reject) => {
        let value = "";
        const finish = (error) => {
            process.stdin.off("data", onData);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdout.write("\n");
            if (error)
                reject(error);
            else
                resolve(value);
        };
        const onData = (chunk) => {
            const data = String(chunk);
            if (data.includes("\u0003"))
                return finish(new CliError(`${label} input cancelled`));
            if (data.includes("\r") || data.includes("\n"))
                return finish();
            if (data === "\u007f" || data === "\b") {
                value = [...value].slice(0, -1).join("");
                return;
            }
            const pasted = data.startsWith("\u001b[200~") && data.endsWith("\u001b[201~")
                ? data.slice(6, -6)
                : data;
            const printable = [...pasted].filter((character) => character >= " " && character <= "~").join("");
            if (value.length + printable.length > 16_384)
                return finish(new CliError(`${label} input exceeds 16384 characters`));
            value += printable;
        };
        process.stdin.on("data", onData);
    });
}
function parseConfigProvider(value) {
    const normalized = value?.trim().toLowerCase();
    if (!normalized || !PROVIDER_OPTIONS.includes(normalized)) {
        throw new CliError("Provider must be deepseek, openai, or custom-openai");
    }
    return normalized;
}
function parseConfigThinking(value) {
    const normalized = value?.trim().toLowerCase();
    if (!normalized || !THINKING_LEVELS.includes(normalized)) {
        throw new CliError(`Thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
    }
    return normalized;
}
function parsePermissionMode(value) {
    const normalized = value?.trim().toLowerCase();
    // `bypass` is the name users reach for; it maps onto the existing allow_all policy.
    const mode = normalized === "bypass" ? "allow_all" : normalized;
    if (!mode || !PERMISSION_MODES.includes(mode)) {
        throw new CliError(`Permission mode must be one of: ${PERMISSION_MODES.join(", ")} (or bypass)`);
    }
    return mode;
}
function parseConfigApi(value) {
    const normalized = value.trim().toLowerCase();
    const api = normalized === "chat" ? "openai-completions" : normalized === "responses" ? "openai-responses" : normalized;
    if (!MODEL_APIS.includes(api) || (api !== "openai-completions" && api !== "openai-responses")) {
        throw new CliError("Custom OpenAI API must be chat/openai-completions or responses/openai-responses");
    }
    return api;
}
function settingsUpdate(settings, changes) {
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
async function runPromptCommand(home, args) {
    let sessionId = "main";
    let textArgs = args;
    if (args[0] === "--session") {
        const selected = args[1];
        if (!selected)
            throw new CliError("prompt --session requires a session ID");
        sessionId = selected;
        textArgs = args.slice(2);
    }
    const text = textArgs.join(" ").trim();
    if (!text)
        throw new CliError("prompt requires text");
    return runPrompt(home, text, sessionId);
}
async function runPrompt(home, text, sessionId) {
    const client = await connectFromEndpoint(home, "prompt");
    let resolveSettled;
    let printedDelta = false;
    const settled = new Promise((resolve) => {
        resolveSettled = resolve;
    });
    const unsubscribe = client.subscribe((event) => {
        const payload = event.payload;
        if (payload["sessionId"] !== sessionId)
            return;
        if (event.type === "message.delta" && typeof payload["delta"] === "string") {
            printedDelta = true;
            process.stdout.write(payload["delta"]);
        }
        if (event.type === "run.settled")
            resolveSettled();
    });
    const abort = () => void client.command("session.abort", { reason: "CLI interrupted" }, { sessionId }).catch(() => undefined);
    process.once("SIGINT", abort);
    try {
        await client.command("session.prompt", { text, mode: "auto" }, { sessionId });
        await settled;
        const snapshot = await client.command("session.snapshot", {}, { sessionId });
        if (!snapshot)
            throw new CliError("Session disappeared before completion");
        const finalText = snapshot.messages.at(-1)?.text;
        if (printedDelta)
            process.stdout.write("\n");
        else
            process.stdout.write(`${finalText ?? ""}\n`);
        return 0;
    }
    finally {
        process.off("SIGINT", abort);
        unsubscribe();
        await client.close();
    }
}
async function printSessions(home) {
    const client = await connectFromEndpoint(home, "sessions");
    try {
        const status = await client.command("status.get", {});
        const roots = Object.values(status.sessions)
            .filter((session) => session.rootSession)
            .map((session) => ({
            id: session.sessionId,
            title: session.rootSession?.title,
            status: session.status,
            messages: session.messages.length,
            updatedAt: session.rootSession?.updatedAt,
        }));
        process.stdout.write(`${JSON.stringify(roots, null, 2)}\n`);
        return 0;
    }
    finally {
        await client.close();
    }
}
async function runSessionCommand(home, args) {
    if (args[0] !== "new")
        throw new CliError("session usage: session new [TITLE]");
    const title = args.slice(1).join(" ").trim();
    const client = await connectFromEndpoint(home, "session-new");
    try {
        const created = await client.command("session.create", title ? { title } : {});
        process.stdout.write(`${created.sessionId}\t${created.rootSession?.title ?? "New session"}\n`);
        return 0;
    }
    finally {
        await client.close();
    }
}
async function printProtocolList(home, command) {
    const client = await connectFromEndpoint(home, command.split(".")[0] ?? "list");
    try {
        const values = await client.command(command, {});
        process.stdout.write(`${JSON.stringify(values, null, 2)}\n`);
        return 0;
    }
    finally {
        await client.close();
    }
}
async function runJob(home, jobId) {
    const client = await connectFromEndpoint(home, "run");
    try {
        const run = await client.command("job.run", { jobId });
        process.stdout.write(`${run.id} ${run.status}${run.reason ? `: ${run.reason}` : run.error ? `: ${run.error}` : ""}\n`);
        return run.status === "succeeded" ? 0 : 1;
    }
    finally {
        await client.close();
    }
}
async function putJobFile(home, path) {
    let value;
    try {
        value = JSON.parse(await readFile(path, "utf8"));
    }
    catch (error) {
        throw new CliError(`Cannot read job JSON ${path}: ${toError(error).message}`);
    }
    if (!isRecord(value) || typeof value["id"] !== "string" || !value["id"].trim()) {
        throw new CliError("Job JSON must contain a non-empty id");
    }
    const client = await connectFromEndpoint(home, "schedule");
    try {
        const jobs = await client.command("jobs.list", {});
        const current = jobs.find((job) => job.id === value["id"]);
        const updated = await client.command("job.put", {
            job: value,
            expectedSha256: current?.sourceSha256 ?? null,
        });
        process.stdout.write(`${updated.id} ${current ? "updated" : "created"} ${updated.sourceSha256 ?? ""}\n`);
        return 0;
    }
    finally {
        await client.close();
    }
}
async function runAgentCommand(home, args) {
    const action = args[0];
    const client = await connectFromEndpoint(home, "agent");
    try {
        let result;
        if (action === "spawn") {
            const objective = args.slice(1).join(" ").trim();
            if (!objective)
                throw new CliError("agent spawn requires an objective");
            const config = await loadConfig(home);
            result = await client.command("agent.spawn", {
                parentId: "main",
                objective,
                cwd: config.runtime.workspace,
                workspaceMode: "shared-read",
                budget: {
                    maxTurns: 8,
                    maxToolCalls: 24,
                    maxInputTokens: 50_000,
                    maxOutputTokens: 8_000,
                    maxChildren: 0,
                },
            });
        }
        else if (action === "send") {
            const agentId = args[1];
            const message = args.slice(2).join(" ").trim();
            if (!agentId || !message)
                throw new CliError("agent send requires AGENT_ID and MESSAGE");
            result = await client.command("agent.send", { agentId, message, mode: "next" });
        }
        else if (action === "cancel") {
            const agentId = args[1];
            if (!agentId || args.length !== 2)
                throw new CliError("agent cancel requires exactly one AGENT_ID");
            result = await client.command("agent.cancel", { agentId, reason: "cancelled from CLI" });
        }
        else if (action === "join") {
            const agentIds = args.slice(1);
            if (agentIds.length === 0)
                throw new CliError("agent join requires at least one AGENT_ID");
            result = await client.command("agent.join", { agentIds, timeoutMs: 300_000 });
        }
        else {
            throw new CliError("agent usage: agent spawn OBJECTIVE | send ID MESSAGE | join ID... | cancel ID");
        }
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
    }
    finally {
        await client.close();
    }
}
async function runMcpCommand(home, args) {
    const action = args[0] ?? "list";
    const client = await connectFromEndpoint(home, "mcp");
    try {
        let result;
        if (action === "list") {
            if (args.length > 1)
                throw new CliError("mcp list does not accept arguments");
            result = await client.command("mcp.servers", {});
        }
        else if (action === "tools") {
            if (args.length > 1)
                throw new CliError("mcp tools does not accept arguments");
            result = await client.command("mcp.tools", {});
        }
        else if (action === "discover" || action === "ping") {
            const serverId = args[1];
            if (!serverId || args.length !== 2)
                throw new CliError(`mcp ${action} requires exactly one SERVER_ID`);
            result = await client.command(action === "discover" ? "mcp.discover" : "mcp.ping", { serverId });
        }
        else {
            throw new CliError("mcp usage: mcp list | tools | discover SERVER_ID | ping SERVER_ID");
        }
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
    }
    finally {
        await client.close();
    }
}
async function printResourceList(home, command) {
    const client = await connectFromEndpoint(home, command.split(".")[0] ?? "resources");
    try {
        const result = await client.command(command, {});
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
    }
    finally {
        await client.close();
    }
}
async function runResourceCommand(home, args) {
    const action = args[0];
    const client = await connectFromEndpoint(home, "resource");
    try {
        let result;
        if (action === "inspect") {
            const stagingPath = args[1];
            if (!stagingPath || args.length !== 2)
                throw new CliError("resource inspect requires exactly one STAGING_PATH");
            result = await client.command("resources.inspect", { stagingPath });
        }
        else if (action === "install") {
            const stagingPath = args[1];
            const expectedDigest = args[2];
            if (!stagingPath || !expectedDigest || args.length !== 3) {
                throw new CliError("resource install requires STAGING_PATH and the exact inspected SHA256");
            }
            result = await client.command("resources.install", { stagingPath, expectedDigest });
        }
        else if (action === "disable") {
            const kind = args[1];
            const name = args[2];
            const expectedDigest = args[3];
            if ((kind !== "skill" && kind !== "host-plugin") || !name || !expectedDigest || args.length !== 4) {
                throw new CliError("resource disable requires KIND(skill|host-plugin), NAME, and exact SHA256");
            }
            result = await client.command("resources.disable", { kind, name, expectedDigest });
        }
        else {
            throw new CliError("resource usage: resource inspect PATH | install PATH SHA256 | disable KIND NAME SHA256");
        }
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
    }
    finally {
        await client.close();
    }
}
async function cancelRun(home, runId) {
    const client = await connectFromEndpoint(home, "cancel");
    try {
        const run = await client.command("run.cancel", { runId });
        process.stdout.write(`${run.id} ${run.status}\n`);
        return 0;
    }
    finally {
        await client.close();
    }
}
async function connectFromEndpoint(home, purpose) {
    const endpoint = await endpointFor(home);
    const client = new ProtocolClient({ socketPath: endpoint.socket, clientId: `${purpose}-${process.pid}` });
    try {
        await client.connect();
        return client;
    }
    catch (error) {
        await client.close().catch(() => undefined);
        throw new CliError(`Cannot connect to pSpore daemon at ${endpoint.socket}: ${toError(error).message}`);
    }
}
async function endpointFor(home) {
    const path = psporePaths(home).endpoint;
    let value;
    try {
        value = JSON.parse(await readFile(path, "utf8"));
    }
    catch (error) {
        throw new CliError(`No service endpoint at ${path}; start it with \`${resolveInvokedName(process.argv[1])} service start\``);
    }
    if (!isRecord(value) || value["version"] !== 1 || typeof value["socket"] !== "string" || typeof value["state"] !== "string") {
        throw new CliError(`Invalid daemon endpoint file: ${path}`);
    }
    return { socket: value["socket"], state: value["state"] };
}
function parseGlobalOptions(argv) {
    const args = [];
    let home;
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === "--home") {
            const value = argv[++index];
            if (!value)
                throw new CliError("--home requires a path");
            home = value;
        }
        else if (argument?.startsWith("--home=")) {
            home = argument.slice("--home=".length);
            if (!home)
                throw new CliError("--home requires a path");
        }
        else if (argument !== undefined) {
            args.push(argument);
        }
    }
    return { ...(home === undefined ? {} : { home }), args };
}
function requireNoArgs(args, command) {
    if (args.length > 0)
        throw new CliError(`${command} does not accept positional arguments`);
}
function helpText() {
    return `pSpore ${PSPORE_VERSION} — Linux local agent core\n\nUsage: ${resolveInvokedName(process.argv[1])} [--home PATH] <command>\n\nCommands:\n  setup            Guided model setup (provider, model, thinking, API key, cookie)\n  init             Initialize private config/workspace/state directories\n  service install  Install, enable, and start the systemd user service\n  service status   Show system service, autostart, and linger state\n  service logs     Show recent system service logs\n  service restart  Restart the full background service\n  service stop     Stop it; service uninstall also removes the unit\n  daemon           Run the service process in the foreground (diagnostics/systemd)\n  tui              Open the reconnecting terminal shell; service stays running after exit\n  desktop          Open the secure Electron 43 shell\n  config wizard    Same guided setup as the setup command\n  config show      Show model settings without exposing the API key or cookie\n  config set ...   Configure DeepSeek, OpenAI, or a custom OpenAI endpoint\n  config permissions MODE\n                   Set the approval policy: ask_risky | ask_all | allow_all (bypass) | deny\n  config key       Read an API key from hidden TTY input or stdin\n  config clear-key Remove the current provider's managed API key\n  config cookie    Read an LLM proxy Cookie header from hidden TTY input or stdin\n  config clear-cookie Remove the current provider's managed Cookie header\n  sessions         List persistent root sessions\n  session new [TITLE]\n                   Create a persistent root session\n  prompt [--session ID] TEXT\n                   Send normally; if busy, continue queuing and wait\n  jobs             List loaded cron jobs\n  runs             List durable automation runs\n  notifications    List durable local notifications\n  agents           List child agents and their current status\n  agent spawn TEXT Spawn a bounded shared-read child agent\n  agent send ID TEXT\n                   Send a queued message to a child agent\n  agent join ID... Wait for one or more child agents\n  agent cancel ID  Cancel a child agent and its descendants\n  mcp list         List configured MCP health without connecting\n  mcp tools        List schemas activated in this service process\n  mcp discover ID  Lazily connect and activate one trusted server\n  mcp ping ID      Check one trusted MCP server connection\n  resources        List trusted skills and host plugins\n  skills           List trusted skills and activation state\n  plugins          List trusted host plugins and activation state\n  resource inspect PATH\n                   Inspect one directory under workspace/staging without executing it\n  resource install PATH SHA256\n                   Trust and install only the exact inspected content digest\n  resource disable KIND NAME SHA256\n                   Revoke trust without deleting installed content\n  schedule put FILE\n                   Atomically create/update a cron job from JSON\n  run JOB_ID       Trigger one job now and wait for completion\n  cancel RUN_ID    Cancel a queued or active run\n  status           Show service and session status\n  doctor           Check Node, config, model, shell, ripgrep, resource trust, MCP, and service\n  version          Print pinned runtime versions\n  help             Show this help\n`;
}
class CliError extends Error {
    constructor(message) {
        super(message);
        this.name = "CliError";
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
if (isEntrypoint(process.argv[1], import.meta.url)) {
    runCli().then((code) => {
        process.exitCode = code;
    }, (error) => {
        process.stderr.write(`pSpore: ${toError(error).message}\n`);
        process.exitCode = 1;
    });
}
export function resolveInvokedName(argvPath) {
    if (!argvPath)
        return DEFAULT_BIN_ALIAS;
    const invoked = basename(argvPath);
    return BIN_ALIASES.has(invoked) ? invoked : DEFAULT_BIN_ALIAS;
}
export function isEntrypoint(argvPath, moduleUrl) {
    if (!argvPath)
        return false;
    try {
        return realpathSync(argvPath) === fileURLToPath(moduleUrl);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=main.js.map