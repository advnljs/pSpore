import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, ipcMain, Menu, screen, Tray } from "electron";
import { NotificationFeed, notificationBounds, notificationSession } from "./notification-model.js";
import { DESKTOP_ICON, isTrustedRendererUrl } from "./security.js";
import { hardenWindow } from "./window-security.js";
import { interfaceLocale } from "./main-i18n.js";
import { waitForRenderer } from "./renderer-diagnostics.js";
import { DESKTOP_FRAME_CHANNEL } from "./ipc-contract.js";
const CURRENT = "pspore:notification:current";
const ACTION = "pspore:notification:action";
const UPDATE = "pspore:notification:update";
const DISPLAY_MS = 12_000;
export async function openNotificationTarget(target, bootstrap, sessionId) {
    if (target.isDestroyed())
        return;
    if (target.isMinimized())
        target.restore();
    target.show();
    target.focus();
    await waitForRenderer(target, "document.documentElement.dataset.ready === 'true'", 15_000);
    const current = bootstrap();
    if (current.snapshot)
        target.webContents.send(DESKTOP_FRAME_CHANNEL, { version: 1, kind: "snapshot", snapshot: current.snapshot, cursors: current.cursors });
    target.webContents.send(DESKTOP_FRAME_CHANNEL, { version: 1, kind: "notification.open", ...(sessionId ? { sessionId } : {}) });
}
/** A small independent shell stays alive while the workspace is hidden. */
export class DesktopNotifications {
    #feed = new NotificationFeed();
    #target;
    #bootstrap;
    #open;
    #quit;
    #tray;
    #popup;
    #record;
    #card;
    #timer;
    #count = 0;
    #disposed = false;
    #loading;
    constructor(options) {
        this.#target = options.target;
        this.#bootstrap = options.bootstrap;
        this.#open = options.open;
        this.#quit = options.quit;
        const snapshot = this.#bootstrap().snapshot;
        if (snapshot)
            this.#feed.accept(snapshot.notifications);
        ipcMain.handle(CURRENT, (event) => { this.#assertSender(event); return this.#card ?? null; });
        ipcMain.handle(ACTION, async (event, action, id) => {
            this.#assertSender(event);
            if (id !== this.#card?.id || !this.#record)
                return;
            if (action === "dismiss")
                this.dismiss();
            else if (action === "pause")
                this.#clearTimer();
            else if (action === "resume")
                this.#startTimer();
            else if (action === "open") {
                const state = this.#bootstrap().snapshot;
                const sessionId = state ? notificationSession(this.#record, state) : undefined;
                await this.#open(sessionId);
                this.dismiss();
            }
            else
                throw new Error("Unknown notification action");
        });
        this.#target.on("focus", this.#onFocus);
        screen.on("display-metrics-changed", this.#position);
        screen.on("display-removed", this.#position);
        if (options.tray !== false) {
            this.#tray = new Tray(DESKTOP_ICON);
            this.#tray.setToolTip("pSpore");
            this.#tray.on("click", () => { void this.#open().catch(this.#reportError); });
            this.updateLocale();
        }
    }
    updateLocale() {
        const en = interfaceLocale() === "en";
        this.#tray?.setContextMenu(Menu.buildFromTemplate([
            { label: en ? "Open pSpore" : "打开 pSpore", click: () => { void this.#open().catch(this.#reportError); } },
            { label: en ? "Notifications active in background" : "正在后台接收通知", enabled: false },
            { type: "separator" },
            { label: en ? "Quit pSpore" : "退出 pSpore", click: this.#quit },
        ]));
    }
    /** Closing hides the workspace; an explicit app/tray quit still tears down. */
    hideOnClose(event) {
        if (this.#disposed)
            return;
        event.preventDefault();
        this.#target.hide();
    }
    receive(frame) {
        if (this.#disposed || (frame.kind !== "snapshot" && !(frame.kind === "event" && frame.event.type === "notification.created")))
            return;
        const state = frame.kind === "snapshot" ? frame.snapshot : this.#bootstrap().snapshot;
        if (!state)
            return;
        const fresh = this.#feed.accept(state.notifications);
        if (!fresh.length || this.#workspaceActive())
            return;
        const record = fresh.at(-1);
        this.#count += fresh.length;
        this.#record = record;
        this.#card = this.#makeCard(record, state);
        void this.#show().catch(this.#reportError);
    }
    dismiss() {
        this.#clearTimer();
        this.#record = undefined;
        this.#card = undefined;
        this.#count = 0;
        if (this.#popup && !this.#popup.isDestroyed())
            this.#popup.hide();
    }
    dispose() {
        this.#disposed = true;
        this.dismiss();
        this.#target.removeListener("focus", this.#onFocus);
        screen.removeListener("display-metrics-changed", this.#position);
        screen.removeListener("display-removed", this.#position);
        ipcMain.removeHandler(CURRENT);
        ipcMain.removeHandler(ACTION);
        this.#tray?.destroy();
        this.#popup?.destroy();
    }
    #makeCard(record, state) {
        const sessionId = notificationSession(record, state);
        const session = sessionId ? state.sessions[sessionId] : undefined;
        return { id: record.id, title: record.title, body: record.body, level: record.level, ts: record.ts,
            sessionTitle: session?.rootSession?.title || session?.firstUserText || sessionId || (interfaceLocale() === "en" ? "Activity & notifications" : "活动与通知"),
            hasSession: Boolean(sessionId), count: this.#count, locale: interfaceLocale() };
    }
    async #show() {
        this.#clearTimer();
        if (!this.#popup || this.#popup.isDestroyed()) {
            const path = fileURLToPath(new URL("./notification/index.html", import.meta.url));
            this.#popup = new BrowserWindow({
                ...notificationBounds(screen.getDisplayMatching(this.#target.getBounds()).workArea),
                show: false, frame: false, transparent: true, backgroundColor: "#00000000",
                resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
                alwaysOnTop: true, skipTaskbar: true, autoHideMenuBar: true,
                ...(process.platform === "linux" ? { type: "notification" } : {}),
                title: "pSpore · Notification", icon: DESKTOP_ICON,
                webPreferences: { preload: fileURLToPath(new URL("./notification/preload.cjs", import.meta.url)),
                    sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
                    webviewTag: false, spellcheck: false, backgroundThrottling: false },
            });
            hardenWindow(this.#popup, pathToFileURL(path).href);
            this.#popup.on("close", (event) => { if (!this.#disposed) {
                event.preventDefault();
                this.dismiss();
            } });
            this.#loading = this.#popup.loadFile(path);
        }
        await this.#loading;
        if (this.#disposed || !this.#card || this.#popup.isDestroyed())
            return;
        if (this.#workspaceActive()) {
            this.dismiss();
            return;
        }
        this.#position();
        this.#popup.webContents.send(UPDATE, this.#card);
        this.#popup.showInactive();
        this.#startTimer();
    }
    #position = () => {
        if (!this.#popup || this.#popup.isDestroyed() || this.#target.isDestroyed())
            return;
        this.#popup.setBounds(notificationBounds(screen.getDisplayMatching(this.#target.getBounds()).workArea));
    };
    #workspaceActive() { return this.#target.isVisible() && !this.#target.isMinimized() && this.#target.isFocused(); }
    #onFocus = () => { this.dismiss(); };
    #clearTimer() { if (this.#timer)
        clearTimeout(this.#timer); this.#timer = undefined; }
    #startTimer() { this.#clearTimer(); if (this.#card)
        this.#timer = setTimeout(() => this.dismiss(), DISPLAY_MS); }
    #reportError = (error) => { process.stderr.write(`pSpore notification: ${error instanceof Error ? error.message : String(error)}\n`); };
    #assertSender(event) {
        const expected = new URL("./notification/index.html", import.meta.url).href;
        if (event.sender !== this.#popup?.webContents || event.senderFrame !== event.sender.mainFrame || !isTrustedRendererUrl(event.senderFrame.url, expected)) {
            throw new Error("Rejected IPC from an untrusted notification renderer");
        }
    }
}
//# sourceMappingURL=desktop-notifications.js.map