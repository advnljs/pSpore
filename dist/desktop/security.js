export const DESKTOP_CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
].join("; ");
export const DESKTOP_PREFERRED_SIZE = { width: 1_920, height: 1_080 };
export const DESKTOP_MINIMUM_SIZE = { width: 1_180, height: 720 };
/**
 * The design baseline is 1920x1080, but requesting that content size on a 1080p
 * screen pushes the window past the bottom of the work area, so the first launch
 * never fills the display. Clamp the request to whatever the desktop actually
 * offers and let the caller maximize from there.
 */
export function desktopInitialSize(workArea) {
    if (!workArea || workArea.width <= 0 || workArea.height <= 0)
        return { ...DESKTOP_PREFERRED_SIZE };
    return {
        width: Math.max(DESKTOP_MINIMUM_SIZE.width, Math.min(DESKTOP_PREFERRED_SIZE.width, Math.floor(workArea.width))),
        height: Math.max(DESKTOP_MINIMUM_SIZE.height, Math.min(DESKTOP_PREFERRED_SIZE.height, Math.floor(workArea.height))),
    };
}
export function desktopWindowOptions(preloadPath, workArea) {
    const initial = desktopInitialSize(workArea);
    return {
        width: initial.width,
        height: initial.height,
        minWidth: DESKTOP_MINIMUM_SIZE.width,
        minHeight: DESKTOP_MINIMUM_SIZE.height,
        useContentSize: true,
        show: false,
        backgroundColor: "#141310",
        title: "pSpore",
        autoHideMenuBar: true,
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            nodeIntegrationInWorker: false,
            nodeIntegrationInSubFrames: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            webviewTag: false,
            spellcheck: false,
            navigateOnDragDrop: false,
        },
    };
}
export function isTrustedRendererUrl(candidate, rendererUrl) {
    try {
        const actual = new URL(candidate);
        const expected = new URL(rendererUrl);
        return actual.protocol === "file:" && actual.href === expected.href;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=security.js.map