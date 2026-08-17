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
export type ResourceHealthStatus = "installed" | "active" | "starting" | "ready" | "disabled" | "blocked" | "degraded" | "stopped";
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
//# sourceMappingURL=types.d.ts.map