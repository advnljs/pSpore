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

export function isDesktopLocale(value: unknown): value is DesktopLocale {
  return value === "zh-CN" || value === "en";
}

/** Any Chinese system language gets the Chinese interface; everything else English. */
export function localeFromLanguageTag(tag: string | undefined): DesktopLocale {
  return /^zh(?:$|[-_])/i.test(tag?.trim() ?? "") ? "zh-CN" : "en";
}

/** Replaces `{name}` placeholders; unknown names are left as written. */
export function formatMessage(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{([A-Za-z_$][\w$]*)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match);
}

export function translateMessage(
  dictionary: Readonly<Record<string, string>>,
  locale: DesktopLocale,
  source: string,
  params?: MessageParams,
): string {
  const template = locale === "en" ? dictionary[source] ?? source : source;
  return formatMessage(template, params);
}
