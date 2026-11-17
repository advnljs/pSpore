import { BrowserWindow } from "electron";
import type { DesktopBootstrap, DesktopFrame } from "./ipc-contract.js";
export declare function openNotificationTarget(target: BrowserWindow, bootstrap: () => DesktopBootstrap, sessionId?: string): Promise<void>;
/** A small independent shell stays alive while the workspace is hidden. */
export declare class DesktopNotifications {
    #private;
    constructor(options: {
        target: BrowserWindow;
        bootstrap: () => DesktopBootstrap;
        open: (sessionId?: string) => Promise<void>;
        quit: () => void;
        tray?: boolean;
    });
    updateLocale(): void;
    /** Closing hides the workspace; an explicit app/tray quit still tears down. */
    hideOnClose(event: {
        preventDefault(): void;
    }): void;
    receive(frame: DesktopFrame): void;
    dismiss(): void;
    dispose(): void;
}
//# sourceMappingURL=desktop-notifications.d.ts.map