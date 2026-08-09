import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultConfig, parseConfig, type PsporeConfig } from "../config/config.js";
import { atomicWriteJson } from "./atomic.js";

export interface PsporePaths {
  home: string;
  config: string;
  workspace: string;
  state: string;
  sessions: string;
  runs: string;
  approvals: string;
  events: string;
  audit: string;
  artifacts: string;
  plugins: string;
  credentials: string;
  cache: string;
  run: string;
  agentDir: string;
  socket: string;
  endpoint: string;
  lock: string;
}

const WORKSPACE_TEMPLATES: Readonly<Record<string, string>> = {
  "AGENTS.md": "# Workspace Rules\n\nAdd workspace-specific operating rules here.\n",
  "SOUL.md": "# Agent Style\n\nBe clear, direct, and careful with side effects.\n",
  "USER.md": "# User Preferences\n\nRecord explicit, durable user preferences here.\n",
  "MEMORY.md": "# Curated Memory\n\nOnly high-value, sourced long-term memory belongs here.\n",
  "TOOLS.md": "# Local Tools\n\nDocument trusted local tools and environment conventions here.\n",
  "BOOT.md": "# Startup Tasks\n\n",
};

export function psporePaths(home: string, workspace?: string): PsporePaths {
  const resolvedWorkspace = workspace ?? join(home, "workspace");
  const state = join(home, "state");
  const run = join(home, "run");
  return {
    home,
    config: join(home, "config.json"),
    workspace: resolvedWorkspace,
    state,
    sessions: join(state, "sessions"),
    runs: join(state, "runs"),
    approvals: join(state, "approvals"),
    events: join(state, "events"),
    audit: join(state, "audit"),
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

export async function initializePsporeHome(home: string): Promise<{ paths: PsporePaths; created: string[] }> {
  const initialPaths = psporePaths(home);
  const created: string[] = [];
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);

  let config: PsporeConfig;
  try {
    config = await loadConfig(home);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
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
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
  return { paths, created };
}

export async function loadConfig(home: string): Promise<PsporeConfig> {
  const path = psporePaths(home).config;
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  return parseConfig(value, home);
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
