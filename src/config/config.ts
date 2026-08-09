import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

import type { ModelRef, ThinkingLevel } from "../domain/runtime.js";

export type PermissionMode = "deny" | "ask_all" | "ask_risky" | "allow_all";

export interface PermissionRule {
  effect: "allow" | "ask" | "deny";
  capability: string;
  target?: string;
}

export interface PsporeConfig {
  version: 1;
  runtime: {
    workspace: string;
    maxConcurrentAgents: number;
    shutdownGraceMs: number;
  };
  model: (ModelRef & { thinking: ThinkingLevel }) | null;
  context: {
    pinnedFiles: string[];
    maxPinnedTokens: number;
  };
  permissions: {
    mode: PermissionMode;
    approvalTimeoutMs: number;
    rules: PermissionRule[];
  };
  memory: {
    provider: "lexical";
    maxResults: number;
    maxReturnedTokens: number;
  };
  shell: {
    executable?: string;
    defaultTimeoutMs: number;
    maxOutputBytes: number;
  };
  scheduler: {
    enabled: boolean;
    maxConcurrentRuns: number;
  };
  boot: {
    enabled: boolean;
  };
  plugins: unknown[];
  mcpServers: unknown[];
}

export function defaultConfig(home: string): PsporeConfig {
  return {
    version: 1,
    runtime: {
      workspace: join(home, "workspace"),
      maxConcurrentAgents: 4,
      shutdownGraceMs: 15_000,
    },
    model: null,
    context: {
      pinnedFiles: ["AGENTS.md", "SOUL.md", "USER.md", "MEMORY.md"],
      maxPinnedTokens: 5_000,
    },
    permissions: {
      mode: "ask_risky",
      approvalTimeoutMs: 300_000,
      rules: [],
    },
    memory: {
      provider: "lexical",
      maxResults: 8,
      maxReturnedTokens: 3_000,
    },
    shell: {
      defaultTimeoutMs: 120_000,
      maxOutputBytes: 1_048_576,
    },
    scheduler: {
      enabled: true,
      maxConcurrentRuns: 2,
    },
    boot: {
      enabled: false,
    },
    plugins: [],
    mcpServers: [],
  };
}

export function parseConfig(value: unknown, home: string): PsporeConfig {
  const root = object(value, "config");
  exactKeys(
    root,
    ["version", "runtime", "model", "context", "permissions", "memory", "shell", "scheduler", "boot", "plugins", "mcpServers"],
    "config",
  );
  if (root["version"] !== 1) throw new Error("config.version must be 1");

  const runtime = object(root["runtime"], "config.runtime");
  exactKeys(runtime, ["workspace", "maxConcurrentAgents", "shutdownGraceMs"], "config.runtime");
  const context = object(root["context"], "config.context");
  exactKeys(context, ["pinnedFiles", "maxPinnedTokens"], "config.context");
  const permissions = object(root["permissions"], "config.permissions");
  exactKeys(permissions, ["mode", "approvalTimeoutMs", "rules"], "config.permissions");
  const memory = object(root["memory"], "config.memory");
  exactKeys(memory, ["provider", "maxResults", "maxReturnedTokens"], "config.memory");
  const shell = object(root["shell"], "config.shell");
  exactKeys(shell, ["executable", "defaultTimeoutMs", "maxOutputBytes"], "config.shell");
  const scheduler = object(root["scheduler"], "config.scheduler");
  exactKeys(scheduler, ["enabled", "maxConcurrentRuns"], "config.scheduler");
  const boot = object(root["boot"], "config.boot");
  exactKeys(boot, ["enabled"], "config.boot");

  const model = parseModel(root["model"]);
  const rules = array(permissions["rules"], "config.permissions.rules").map((rule, index) =>
    parsePermissionRule(rule, index),
  );
  const pinnedFiles = array(context["pinnedFiles"], "config.context.pinnedFiles").map((file, index) =>
    string(file, `config.context.pinnedFiles[${index}]`),
  );
  const plugins = array(root["plugins"], "config.plugins");
  const mcpServers = array(root["mcpServers"], "config.mcpServers");
  const shellExecutable = shell["executable"];

  return {
    version: 1,
    runtime: {
      workspace: resolveConfiguredPath(string(runtime["workspace"], "config.runtime.workspace"), home),
      maxConcurrentAgents: positiveInteger(runtime["maxConcurrentAgents"], "config.runtime.maxConcurrentAgents"),
      shutdownGraceMs: positiveInteger(runtime["shutdownGraceMs"], "config.runtime.shutdownGraceMs"),
    },
    model,
    context: {
      pinnedFiles,
      maxPinnedTokens: positiveInteger(context["maxPinnedTokens"], "config.context.maxPinnedTokens"),
    },
    permissions: {
      mode: enumeration(permissions["mode"], ["deny", "ask_all", "ask_risky", "allow_all"], "config.permissions.mode"),
      approvalTimeoutMs: positiveInteger(permissions["approvalTimeoutMs"], "config.permissions.approvalTimeoutMs"),
      rules,
    },
    memory: {
      provider: enumeration(memory["provider"], ["lexical"], "config.memory.provider"),
      maxResults: positiveInteger(memory["maxResults"], "config.memory.maxResults"),
      maxReturnedTokens: positiveInteger(memory["maxReturnedTokens"], "config.memory.maxReturnedTokens"),
    },
    shell: {
      ...(shellExecutable === undefined
        ? {}
        : { executable: resolveConfiguredPath(string(shellExecutable, "config.shell.executable"), home) }),
      defaultTimeoutMs: positiveInteger(shell["defaultTimeoutMs"], "config.shell.defaultTimeoutMs"),
      maxOutputBytes: positiveInteger(shell["maxOutputBytes"], "config.shell.maxOutputBytes"),
    },
    scheduler: {
      enabled: boolean(scheduler["enabled"], "config.scheduler.enabled"),
      maxConcurrentRuns: positiveInteger(scheduler["maxConcurrentRuns"], "config.scheduler.maxConcurrentRuns"),
    },
    boot: { enabled: boolean(boot["enabled"], "config.boot.enabled") },
    plugins,
    mcpServers,
  };
}

export function resolvePsporeHome(input = process.env["PSPORE_HOME"]): string {
  if (!input) return join(homedir(), ".pspore");
  return resolveConfiguredPath(input, homedir());
}

function parseModel(value: unknown): PsporeConfig["model"] {
  if (value === null) return null;
  const model = object(value, "config.model");
  exactKeys(model, ["provider", "model", "thinking"], "config.model");
  return {
    provider: string(model["provider"], "config.model.provider"),
    model: string(model["model"], "config.model.model"),
    thinking: enumeration(
      model["thinking"],
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      "config.model.thinking",
    ),
  };
}

function parsePermissionRule(value: unknown, index: number): PermissionRule {
  const path = `config.permissions.rules[${index}]`;
  const rule = object(value, path);
  exactKeys(rule, ["effect", "capability", "target"], path);
  const target = rule["target"];
  return {
    effect: enumeration(rule["effect"], ["allow", "ask", "deny"], `${path}.effect`),
    capability: string(rule["capability"], `${path}.capability`),
    ...(target === undefined ? {} : { target: string(target, `${path}.target`) }),
  };
}

function resolveConfiguredPath(input: string, home: string): string {
  const expanded = input === "~" ? home : input.startsWith("~/") ? join(home, input.slice(2)) : input;
  return normalize(isAbsolute(expanded) ? expanded : resolve(expanded));
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${path} must be a positive safe integer`);
  return Number(value);
}

function enumeration<const T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${path} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) throw new Error(`${path} contains unknown keys: ${unknown.join(", ")}`);
  for (const required of allowed) {
    if (!(required in value) && required !== "executable" && required !== "target") {
      throw new Error(`${path}.${required} is required`);
    }
  }
}
