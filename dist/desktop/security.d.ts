import type { BrowserWindowConstructorOptions } from "electron";
export declare const DESKTOP_CSP: string;
export declare function desktopWindowOptions(preloadPath: string): BrowserWindowConstructorOptions;
export declare function isTrustedRendererUrl(candidate: string, rendererUrl: string): boolean;
//# sourceMappingURL=security.d.ts.map