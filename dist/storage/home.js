import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultConfig, parseConfig } from "../config/config.js";
import { atomicWriteJson } from "./atomic.js";
const WORKSPACE_TEMPLATES = {
    "AGENTS.md": "# Workspace Rules\n\nAdd workspace-specific operating rules here.\n",
    "SOUL.md": "# Agent Style\n\nBe clear, direct, and careful with side effects.\n",
    "USER.md": "# User Preferences\n\nRecord explicit, durable user preferences here.\n",
    "MEMORY.md": "# Curated Memory\n\nOnly high-value, sourced long-term memory belongs here.\n",
    "TOOLS.md": "# Local Tools\n\nDocument trusted local tools and environment conventions here.\n",
    "BOOT.md": "# Startup Tasks\n\n",
};
export function psporePaths(home, workspace) {
    const resolvedWorkspace = workspace ?? join(home, "workspace");
    const state = join(home, "state");
    const run = join(home, "run");
    return {
        home,
        config: join(home, "config.json"),
        workspace: resolvedWorkspace,
        state,
        sessions: join(state, "sessions"),
        sessionCatalog: join(state, "session-catalog.json"),
        runs: join(state, "runs"),
        approvals: join(state, "approvals"),
        events: join(state, "events"),
        audit: join(state, "audit"),
        resourceTrust: join(state, "resource-trust.json"),
        artifacts: join(home, "artifacts"),
        plugins: join(home, "plugins"),
        credentials: join(home, "credentials"),
        cache: join(home, "cache", "search"),
        run,
        agentDir: join(state, "pi"),
        socket: join(run, "daemon.sock"),
        endpoint: join(run, "endpoint.json"),
        lock: join(run, "daemon.lock"),
    };
}
export async function initializePsporeHome(home) {
    const initialPaths = psporePaths(home);
    const created = [];
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    let config;
    try {
        config = await loadConfig(home);
    }
    catch (error) {
        if (!isMissingFile(error))
            throw error;
        config = defaultConfig(home);
        await atomicWriteJson(initialPaths.config, config, 0o600);
        created.push(initialPaths.config);
    }
    const paths = psporePaths(home, config.runtime.workspace);
    const directories = [
        paths.workspace,
        join(paths.workspace, "memory"),
        join(paths.workspace, "memory", "topics"),
        join(paths.workspace, "jobs"),
        join(paths.workspace, "skills"),
        join(paths.workspace, "staging"),
        join(paths.workspace, "trash"),
        paths.state,
        paths.sessions,
        paths.runs,
        paths.approvals,
        paths.events,
        paths.audit,
        paths.artifacts,
        paths.plugins,
        paths.credentials,
        paths.cache,
        paths.run,
        paths.agentDir,
    ];
    for (const directory of directories) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
    }
    for (const [name, content] of Object.entries(WORKSPACE_TEMPLATES)) {
        const path = join(paths.workspace, name);
        try {
            await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
            created.push(path);
        }
        catch (error) {
            if (!isAlreadyExists(error))
                throw error;
        }
    }
    return { paths, created };
}
export async function loadConfig(home) {
    const path = psporePaths(home).config;
    const value = JSON.parse(await readFile(path, "utf8"));
    return parseConfig(value, home);
}
function isMissingFile(error) {
    return isNodeError(error) && error.code === "ENOENT";
}
function isAlreadyExists(error) {
    return isNodeError(error) && error.code === "EEXIST";
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
//# sourceMappingURL=home.js.map