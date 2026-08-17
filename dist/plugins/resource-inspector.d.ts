import type { ResourceFileDescriptor, ResourceKind, StagedResourceInspection } from "./types.js";
interface SnapshotFile extends ResourceFileDescriptor {
    content: Buffer;
}
export interface ResourceSnapshot {
    directory: string;
    inspection: StagedResourceInspection;
    files: readonly SnapshotFile[];
}
export declare function resolveStagedResource(stagingRoot: string, input: string): Promise<string>;
export declare function inspectResourceDirectory(directory: string): Promise<ResourceSnapshot>;
export declare function installSnapshot(snapshot: ResourceSnapshot, destination: string): Promise<void>;
export declare function resourceInstallPath(kind: ResourceKind, name: string, digest: string, skillsRoot: string, pluginsRoot: string): string;
export declare function validateDigest(value: string, path: string): void;
export declare function validateName(value: string, path: string): void;
export declare function resourceKey(kind: ResourceKind, name: string): string;
export {};
//# sourceMappingURL=resource-inspector.d.ts.map