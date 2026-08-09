import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { PermissionMode, PermissionRule } from "../config/config.js";
import type { ToolAuthorizationRequest } from "../domain/runtime.js";

export type Capability =
  | "fs.read"
  | "fs.write"
  | "fs.delete"
  | "process.exec"
  | "process.signal"
  | "process.pty"
  | "network.connect"
  | "network.publish"
  | "privilege.escalate"
  | "schedule.read"
  | "schedule.write"
  | "agent.spawn"
  | "agent.message"
  | "memory.read"
  | "memory.write"
  | "external.side_effect";

export interface PolicyEvaluation {
  decision: "allow" | "ask" | "deny";
  capability: Capability;
  canonicalTarget?: string;
  summary: string;
  command?: string;
  cwd?: string;
  riskReasons: string[];
}

export interface PolicyEngineOptions {
  mode: PermissionMode;
  rules: readonly PermissionRule[];
  workspaceRoot: string;
  cwd: string;
}

const MUTATING_CAPABILITIES = new Set<Capability>([
  "fs.write",
  "fs.delete",
  "process.exec",
  "process.signal",
  "process.pty",
  "network.connect",
  "network.publish",
  "privilege.escalate",
  "schedule.write",
  "agent.spawn",
  "agent.message",
  "memory.write",
  "external.side_effect",
]);

const SENSITIVE_PATH_PARTS = [".env", "credentials", ".ssh", ".gnupg", "keyring", "secrets"];

export class PolicyEngine {
  readonly #mode: PermissionMode;
  readonly #rules: readonly PermissionRule[];
  readonly #workspaceRoot: string;
  readonly #cwd: string;

  private constructor(options: PolicyEngineOptions, workspaceRoot: string, cwd: string) {
    this.#mode = options.mode;
    this.#rules = options.rules;
    this.#workspaceRoot = workspaceRoot;
    this.#cwd = cwd;
  }

  static async create(options: PolicyEngineOptions): Promise<PolicyEngine> {
    return new PolicyEngine(options, await realpath(options.workspaceRoot), await realpath(options.cwd));
  }

  async evaluate(request: ToolAuthorizationRequest): Promise<PolicyEvaluation> {
    const classified = await this.#classify(request);
    const matchingRules = this.#rules.filter(
      (rule) =>
        (rule.capability === "*" || rule.capability === classified.capability) &&
        (rule.target === undefined || targetMatches(rule.target, classified.canonicalTarget)),
    );
    const explicit = matchingRules.some((rule) => rule.effect === "deny")
      ? "deny"
      : matchingRules.some((rule) => rule.effect === "ask")
        ? "ask"
        : matchingRules.some((rule) => rule.effect === "allow")
          ? "allow"
          : undefined;

    if (explicit) return { ...classified, decision: explicit };
    switch (this.#mode) {
      case "deny":
        return { ...classified, decision: "deny" };
      case "allow_all":
        return { ...classified, decision: "allow" };
      case "ask_all":
        return {
          ...classified,
          decision:
            MUTATING_CAPABILITIES.has(classified.capability) || classified.riskReasons.length > 0 ? "ask" : "allow",
        };
      case "ask_risky":
        return { ...classified, decision: classified.riskReasons.length > 0 ? "ask" : "allow" };
    }
  }

  async #classify(request: ToolAuthorizationRequest): Promise<Omit<PolicyEvaluation, "decision">> {
    const input = request.input;
    switch (request.toolName) {
      case "read":
      case "search": {
        const path = stringInput(input, "path") ?? this.#workspaceRoot;
        const canonicalTarget = await canonicalizePotentialPath(path, this.#cwd);
        return {
          capability: "fs.read",
          canonicalTarget,
          summary: `${request.toolName} ${canonicalTarget}`,
          riskReasons: this.#pathRisks(canonicalTarget, true),
        };
      }
      case "edit":
      case "memory_append":
      case "memory_curate": {
        const path = stringInput(input, "path") ?? this.#workspaceRoot;
        const canonicalTarget = await canonicalizePotentialPath(path, this.#cwd);
        return {
          capability: request.toolName.startsWith("memory_") ? "memory.write" : "fs.write",
          canonicalTarget,
          summary: `${request.toolName} ${canonicalTarget}`,
          riskReasons: this.#pathRisks(canonicalTarget, false),
        };
      }
      case "shell": {
        const command = stringInput(input, "command") ?? "";
        const cwd = await canonicalizePotentialPath(stringInput(input, "cwd") ?? this.#cwd, this.#cwd);
        const shellRisks = classifyShellRisk(command);
        return {
          capability: shellRisks.some((reason) => reason.startsWith("privilege")) ? "privilege.escalate" : "process.exec",
          canonicalTarget: cwd,
          summary: `shell in ${cwd}`,
          command,
          cwd,
          riskReasons: [...this.#pathRisks(cwd, false), ...shellRisks],
        };
      }
      case "notify":
        return {
          capability: "external.side_effect",
          canonicalTarget: "local-notification",
          summary: "send a local notification",
          riskReasons: [],
        };
      case "schedule": {
        const action = stringInput(input, "action") ?? "unknown";
        const job = input["job"];
        const jobId = isRecord(job) ? stringInput(job, "id") : undefined;
        return {
          capability: action === "list" ? "schedule.read" : "schedule.write",
          canonicalTarget: jobId ? `job:${jobId}` : "jobs",
          summary: action === "list" ? "list scheduled jobs" : `update scheduled job ${jobId ?? "unknown"}`,
          riskReasons: action === "list" ? [] : ["scheduled activity persists beyond the current session"],
        };
      }
      default:
        return {
          capability: "external.side_effect",
          canonicalTarget: request.toolName,
          summary: `invoke unclassified tool ${request.toolName}`,
          riskReasons: ["unclassified tool capability"],
        };
    }
  }

  #pathRisks(path: string, reading: boolean): string[] {
    const risks: string[] = [];
    if (!isWithin(this.#workspaceRoot, path)) risks.push("target is outside the configured workspace");
    const lower = path.toLowerCase();
    if (reading && SENSITIVE_PATH_PARTS.some((part) => lower.includes(part))) {
      risks.push("target path may contain credentials or secrets");
    }
    return risks;
  }
}

export function classifyShellRisk(command: string): string[] {
  const risks: string[] = [];
  const normalized = command.replace(/\s+/g, " ").trim().toLowerCase();
  if (/(^|[;&|]\s*|\s)(sudo|doas|su)(\s|$)/.test(normalized)) risks.push("privilege escalation command");
  if (/\brm\s+[^\n]*(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)/.test(normalized)) {
    risks.push("recursive or forced deletion");
  }
  if (/\b(mkfs|fdisk|parted|dd)\b|>\s*\/dev\//.test(normalized)) risks.push("disk or device mutation");
  if (/\b(systemctl|service|mount|umount|shutdown|reboot)\b/.test(normalized)) risks.push("system service or host state mutation");
  if (/\b(curl|wget)\b[^|\n]*\|\s*(?:ba)?sh\b/.test(normalized)) risks.push("downloaded content piped to a shell");
  if (/\bgit\s+(push|tag)|\bnpm\s+publish\b|\bgh\s+release\b/.test(normalized)) risks.push("publishing or remote repository mutation");
  if (/\bchmod\s+-r|\bchown\s+-r|>\s*\/(etc|boot|usr|var)\//.test(normalized)) risks.push("protected or recursive filesystem mutation");
  if (/\bnohup\b|\bdisown\b|\bsystemd-run\b|&\s*$/.test(normalized)) risks.push("detached or persistent process");
  return [...new Set(risks)];
}

async function canonicalizePotentialPath(input: string, cwd: string): Promise<string> {
  const absolute = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
  try {
    return await realpath(absolute);
  } catch {
    const parent = await realpath(dirname(absolute));
    const candidate = resolve(parent, basename(absolute));
    const metadata = await stat(parent);
    if (!metadata.isDirectory()) throw new Error(`Path parent is not a directory: ${parent}`);
    return candidate;
  }
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function targetMatches(pattern: string, target: string | undefined): boolean {
  if (!target) return false;
  if (pattern.endsWith("/**")) return target === pattern.slice(0, -3) || target.startsWith(`${pattern.slice(0, -3)}${sep}`);
  if (!pattern.includes("*")) return target === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(target);
}

function stringInput(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
