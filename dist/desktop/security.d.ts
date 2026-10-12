import type { BrowserWindowConstructorOptions } from "electron";
export declare const DESKTOP_ICON: string;
export declare const DESKTOP_CSP: string;
export declare const DESKTOP_PREFERRED_SIZE: {
    readonly width: 1920;
    readonly height: 1080;
};
export declare const DESKTOP_MINIMUM_SIZE: {
    readonly width: 1180;
    readonly height: 720;
};
/**
 * The design baseline is 1920x1080, but requesting that content size on a 1080p
 * screen pushes the window past the bottom of the work area, so the first launch
 * never fills the display. Clamp the request to whatever the desktop actually
 * offers and let the caller maximize from there.
 */
export declare function desktopInitialSize(workArea?: {
    width: number;
    height: number;
}): {
    width: number;
    height: number;
};
export declare function desktopWindowOptions(preloadPath: string, workArea?: {
    width: number;
    height: number;
}): BrowserWindowConstructorOptions;
export declare function isTrustedRendererUrl(candidate: string, rendererUrl: string): boolean;
//# sourceMappingURL=security.d.ts.map