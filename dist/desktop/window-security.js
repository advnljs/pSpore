import { app, session } from "electron";
import { isTrustedRendererUrl } from "./security.js";
export function installSessionSecurity() {
    const desktopSession = session.defaultSession;
    desktopSession.setPermissionCheckHandler(() => false);
    desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    desktopSession.on("will-download", (event) => event.preventDefault());
    desktopSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
    app.on("web-contents-created", (_event, contents) => {
        contents.on("will-attach-webview", (event) => event.preventDefault());
    });
}
export function hardenWindow(target, expectedUrl) {
    const contents = target.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
        if (!isTrustedRendererUrl(url, expectedUrl))
            event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
        if (!isTrustedRendererUrl(url, expectedUrl))
            event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
}
//# sourceMappingURL=window-security.js.map