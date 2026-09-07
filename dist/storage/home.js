import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultConfig, parseConfig, withConfigDefaults } from "../config/config.js";
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
        config = await upgradeConfigInPlace(home, initialPaths.config);
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
/**
 * Overlay upgrades only replace the application payload, so the existing
 * `config.json` has to survive a build that added new keys. Missing keys inherit
 * the current defaults and the merged document is written back once, while every
 * value the user already set is preserved byte-for-byte.
 */
async function upgradeConfigInPlace(home, path) {
    const stored = JSON.parse(await readFile(path, "utf8"));
    const config = parseConfig(stored, home);
    if (!sectionsComplete(stored, home))
        await atomicWriteJson(path, config, 0o600);
    return config;
}
/** True when the stored document already carries every key this build knows about. */
function sectionsComplete(stored, home) {
    const base = isPlainObject(stored) ? stored : {};
    for (const [key, value] of Object.entries(withConfigDefaults(stored, home))) {
        const current = base[key];
        if (current === undefined)
            return false;
        if (!isPlainObject(value))
            continue;
        if (!isPlainObject(current))
            return false;
        for (const nested of Object.keys(value)) {
            if (current[nested] === undefined)
                return false;
        }
    }
    return true;
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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