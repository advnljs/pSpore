import { type DesktopLocale, type MessageParams } from "../i18n.js";
/**
 * Fixed for the page's lifetime: switching language reloads the window, so no
 * label ever has to be re-rendered in place. Outside a browser document (unit
 * tests import renderer modules under Node) messages stay in Chinese, the
 * language they are written in.
 */
export declare const locale: DesktopLocale;
/** The interface text for a message written in Chinese at its call site. */
export declare function t(source: string, params?: MessageParams): string;
/** Remembers an explicit choice; it outranks the system language from then on. */
export declare function saveLocalePreference(next: DesktopLocale): void;
/**
 * The control that switches language, by the language now showing. It names
 * the other language in that language's own words, so someone who cannot read
 * the current one can still find it.
 */
export declare const LANGUAGE_SWITCH: Readonly<Record<DesktopLocale, {
    text: string;
    label: string;
    lang: DesktopLocale;
}>>;
/**
 * Translates the static markup in index.html. Text nodes and the few
 * user-facing attributes are matched by their whitespace-collapsed Chinese
 * text, so the markup needs no per-element keys.
 */
export declare function translateStaticDocument(root: Document): void;
//# sourceMappingURL=i18n.d.ts.map