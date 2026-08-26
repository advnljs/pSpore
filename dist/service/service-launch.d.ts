import type { SystemServiceLaunchSpec } from "./system-service.js";
export interface ServiceRuntimeIdentity {
    execPath: string;
    argvEntry?: string;
    moduleUrl: string;
    electron?: boolean;
}
/** Build a stable service command for npm, source builds, SEA, or Electron packages. */
export declare function serviceLaunchSpec(home: string, workspace: string, identity: ServiceRuntimeIdentity): Promise<SystemServiceLaunchSpec>;
//# sourceMappingURL=service-launch.d.ts.map