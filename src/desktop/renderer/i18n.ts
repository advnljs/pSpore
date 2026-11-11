import { isDesktopLocale, localeFromLanguageTag, translateMessage, type DesktopLocale, type MessageParams } from "../i18n.js";
import { EN_MESSAGES } from "./messages-en.js";

const LOCALE_STORAGE_KEY = "pspore.desktop.locale";

function storedLocale(): DesktopLocale | undefined {
  try {
    const stored = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY);
    return isDesktopLocale(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fixed for the page's lifetime: switching language reloads the window, so no
 * label ever has to be re-rendered in place. Outside a browser document (unit
 * tests import renderer modules under Node) messages stay in Chinese, the
 * language they are written in.
 */
export const locale: DesktopLocale = typeof document === "undefined"
  ? "zh-CN"
  : storedLocale() ?? localeFromLanguageTag(globalThis.navigator?.language);

/** The interface text for a message written in Chinese at its call site. */
export function t(source: string, params?: MessageParams): string {
  return translateMessage(EN_MESSAGES, locale, source, params);
}

/** Remembers an explicit choice; it outranks the system language from then on. */
export function saveLocalePreference(next: DesktopLocale): void {
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    // Without storage the choice lasts for this window only.
  }
}

/**
 * The control that switches language, by the language now showing. It names
 * the other language in that language's own words, so someone who cannot read
 * the current one can still find it.
 */
export const LANGUAGE_SWITCH: Readonly<Record<DesktopLocale, { text: string; label: string; lang: DesktopLocale }>> = Object.freeze({
  "zh-CN": { text: "EN", label: "Switch to English", lang: "en" },
  en: { text: "中", label: "切换到中文", lang: "zh-CN" },
});

const TRANSLATED_ATTRIBUTES = ["title", "aria-label", "placeholder"] as const;

/**
 * Translates the static markup in index.html. Text nodes and the few
 * user-facing attributes are matched by their whitespace-collapsed Chinese
 * text, so the markup needs no per-element keys.
 */
export function translateStaticDocument(root: Document): void {
  root.documentElement.lang = locale;
  if (locale === "zh-CN") return;
  root.title = t(root.title);
  const walker = root.createTreeWalker(root.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    const key = text.replace(/\s+/g, " ").trim();
    if (!key || !Object.hasOwn(EN_MESSAGES, key)) continue;
    const leading = /^\s*/.exec(text)?.[0] ?? "";
    const trailing = /\s*$/.exec(text)?.[0] ?? "";
    node.nodeValue = `${leading}${t(key)}${trailing}`;
  }
  // A label whose Chinese text carries two meanings names its entry directly.
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("[data-i18n]"))) {
    const key = element.dataset["i18n"];
    if (key && Object.hasOwn(EN_MESSAGES, key)) element.textContent = t(key);
  }
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("[title], [aria-label], [placeholder]"))) {
    for (const name of TRANSLATED_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value && Object.hasOwn(EN_MESSAGES, value)) element.setAttribute(name, t(value));
    }
  }
}
