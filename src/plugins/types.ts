export type ResourceKind = "skill" | "host-plugin";

export type PluginContribution = "trigger" | "tool" | "retrieval" | "executor" | "transport";

export interface HostPluginManifest {
  apiVersion: 1;
  name: string;
  version: string;
  entry: string;
  capabilities: string[];
  contributes: PluginContribution[];
}

export interface HostPluginActivationConfig {
  name: string;
  enabled: boolean;
  digest: string;
  grantedCapabilities: string[];
}

export interface ResourceFileDescriptor {
  path: string;
  bytes: number;
  sha256: string;
  executable: boolean;
}

export interface ResourceDependency {
  name: string;
  version: string;
  kind: "dependency" | "optional" | "peer";
}

export interface StagedResourceInspection {
  version: 1;
  kind: ResourceKind;
  sourcePath: string;
  name: string;
  resourceVersion: string;
  description?: string;
  digest: string;
  entry: string;
  files: ResourceFileDescriptor[];
  totalBytes: number;
  dependencies: ResourceDependency[];
  lifecycleScripts: string[];
  capabilities: string[];
  contributes: PluginContribution[];
  diagnostics: string[];
  installable: boolean;
}

export interface TrustedResourceRecord {
  version: 1;
  kind: ResourceKind;
  name: string;
  resourceVersion: string;
  description?: string;
  digest: string;
  entry: string;
  capabilities: string[];
  contributes: PluginContribution[];
  trusted: boolean;
  installedAt: string;
}

export type ResourceHealthStatus =
  | "installed"
  | "active"
  | "starting"
  | "ready"
  | "disabled"
  | "blocked"
  | "degraded"
  | "stopped";

export interface ResourceHealthRecord {
  version: 1;
  key: string;
  kind: ResourceKind;
  name: string;
  resourceVersion: string;
  digest: string;
  status: ResourceHealthStatus;
  updatedAt: string;
  restartRequired: boolean;
  message?: string;
}

export interface ResourceCatalogEntry {
  record: TrustedResourceRecord;
  health: ResourceHealthRecord;
  installPath: string;
}

/**
 * Where a skill a session can load came from. `installed` went through the
 * staged exact-digest trust flow, `bundled` ships inside the release, and
 * `workspace` is a directory the user put under `workspace/skills/` themselves.
 */
export type SkillSource = "installed" | "bundled" | "workspace";

/**
 * `active`: new sessions offer it to the model. `skipped`: it could not be
 * loaded, and `message` says why. `shadowed`: another skill already owns its
 * name, so this copy is ignored.
 */
export type SkillCatalogStatus = "active" | "skipped" | "shadowed";

export interface SkillCatalogEntry {
  name: string;
  source: SkillSource;
  status: SkillCatalogStatus;
  /** The instructions file the model reads when it selects the skill. */
  path: string;
  description?: string;
  message?: string;
}

/** A workspace skill resolved far enough to be offered to a session as-is. */
export interface SessionSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
}

export interface HostPluginHealth {
  status: "ready" | "degraded";
  message?: string;
}

export interface HostPluginContext {
  apiVersion: 1;
  name: string;
  version: string;
  digest: string;
  capabilities: readonly string[];
  contributes: readonly PluginContribution[];
  signal: AbortSignal;
  report(message: string): void;
}

export interface HostPlugin {
  start(context: HostPluginContext, signal: AbortSignal): Promise<void> | void;
  health?(): Promise<HostPluginHealth> | HostPluginHealth;
  stop(reason: string): Promise<void> | void;
}
