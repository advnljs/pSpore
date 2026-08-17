import type { HostPluginActivationConfig, ResourceCatalogEntry, ResourceHealthRecord, ResourceKind, StagedResourceInspection } from "./types.js";
export interface ExtensionManagerOptions {
    stagingRoot: string;
    skillsRoot: string;
    pluginsRoot: string;
    trustPath: string;
    activations: readonly HostPluginActivationConfig[];
    lifecycleTimeoutMs?: number;
    clock?: () => Date;
    onHealth?: (health: ResourceHealthRecord) => void;
    onError?: (error: Error) => void;
}
export declare class ExtensionManager {
    #private;
    private constructor();
    static create(options: ExtensionManagerOptions): Promise<ExtensionManager>;
    inspect(stagingPath: string): Promise<StagedResourceInspection>;
    install(stagingPath: string, expectedDigest: string): Promise<ResourceCatalogEntry>;
    disable(kind: ResourceKind, name: string, expectedDigest: string): Promise<ResourceCatalogEntry>;
    list(): ResourceCatalogEntry[];
    listHealth(): ResourceHealthRecord[];
    skillPaths(): Promise<string[]>;
    startHostPlugins(): Promise<void>;
    stop(reason?: string): Promise<void>;
}
export declare function readResourceTrustSummary(trustPath: string): Promise<{
    trusted: number;
    disabled: number;
    skills: number;
    hostPlugins: number;
}>;
//# sourceMappingURL=extension-manager.d.ts.map