import { type DesktopLocale, type MessageParams } from "./i18n.js";
export declare function interfaceLocale(): DesktopLocale;
export declare function setInterfaceLocale(next: unknown): DesktopLocale | undefined;
/** `remembered` is the language the window last reported, when one was saved. */
export declare function initialInterfaceLocale(systemTag: string, remembered: string | undefined): DesktopLocale;
/** The language the window reported last time, so the next start opens in it. */
export declare function readRememberedLocale(directory: string): Promise<string | undefined>;
export declare function rememberLocale(directory: string, locale: DesktopLocale): Promise<void>;
export declare function mt(source: string, params?: MessageParams): string;
export declare const MAIN_EN_MESSAGES: Readonly<Record<string, string>>;
//# sourceMappingURL=main-i18n.d.ts.map