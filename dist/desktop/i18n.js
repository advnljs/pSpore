export function isDesktopLocale(value) {
    return value === "zh-CN" || value === "en";
}
/** Any Chinese system language gets the Chinese interface; everything else English. */
export function localeFromLanguageTag(tag) {
    return /^zh(?:$|[-_])/i.test(tag?.trim() ?? "") ? "zh-CN" : "en";
}
/** Replaces `{name}` placeholders; unknown names are left as written. */
export function formatMessage(template, params) {
    if (!params)
        return template;
    return template.replace(/\{([A-Za-z_$][\w$]*)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
}
export function translateMessage(dictionary, locale, source, params) {
    const template = locale === "en" ? dictionary[source] ?? source : source;
    return formatMessage(template, params);
}
//# sourceMappingURL=i18n.js.map