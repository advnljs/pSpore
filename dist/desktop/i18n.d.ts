/**
 * Desktop interface languages. Chinese is the source language: every message
 * is written in Chinese where it is used, and a dictionary maps that exact
 * text to its English form. A message missing from the dictionary therefore
 * falls back to Chinese instead of to an empty or broken label.
 *
 * Shared by the main process and the sandboxed renderer, so it must stay free
 * of Node built-ins and of the DOM.
 */
export type DesktopLocale = "zh-CN" | "en";
export type MessageParams = Readonly<Record<string, string | number>>;
export declare function isDesktopLocale(value: unknown): value is DesktopLocale;
/** Any Chinese system language gets the Chinese interface; everything else English. */
export declare function localeFromLanguageTag(tag: string | undefined): DesktopLocale;
/** Replaces `{name}` placeholders; unknown names are left as written. */
export declare function formatMessage(template: string, params?: MessageParams): string;
export declare function translateMessage(dictionary: Readonly<Record<string, string>>, locale: DesktopLocale, source: string, params?: MessageParams): string;
//# sourceMappingURL=i18n.d.ts.map