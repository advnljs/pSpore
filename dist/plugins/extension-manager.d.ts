import type { HostPluginActivationConfig, ResourceCatalogEntry, ResourceHealthRecord, ResourceKind, StagedResourceInspection } from "./types.js";
import { type BundledSkillLinkResult } from "./bundled-skills.js";
export interface ExtensionManagerOptions {
    stagingRoot: string;
    skillsRoot: string;
    /**
     * Directory of skills shipped inside the release. They are linked into
     * `skillsRoot` on startup and offered to Pi alongside user-installed skills,
     * without going through the staged inspect/install trust flow: they are part
     * of the application payload, so they are already as trusted as the binary.
     */
    bundledSkillsRoot?: string;
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
    /** Bundled skills shipped by this release, with how each was reconciled. */
    listBundledSkills(): BundledSkillLinkResult[];
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