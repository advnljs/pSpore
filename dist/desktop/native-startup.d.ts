import type { DesktopStartup } from "./main.js";
/** Connect only when the native launcher has already drawn the startup card. */
export declare function connectNativeStartup(onFocus: () => void, name?: string | undefined): Promise<DesktopStartup | undefined>;
//# sourceMappingURL=native-startup.d.ts.map