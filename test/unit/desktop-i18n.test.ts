import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { formatMessage, localeFromLanguageTag, translateMessage } from "../../src/desktop/i18n.js";
import { initialInterfaceLocale, MAIN_EN_MESSAGES, mt, setInterfaceLocale } from "../../src/desktop/main-i18n.js";
import { EN_MESSAGES } from "../../src/desktop/renderer/messages-en.js";

const HAN = /[一-鿿]/;
const source = (path: string): string => readFileSync(new URL(`../../src/desktop/${path}`, import.meta.url), "utf8");
const placeholders = (text: string): string[] => [...text.matchAll(/\{[A-Za-z_$][\w$]*\}/g)].map((match) => match[0]).sort();

function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** First arguments of `name("...")` calls whose text is Chinese. */
function calledKeys(code: string, name: string): string[] {
  const pattern = new RegExp(`\\b${name}\\(\\s*"((?:[^"\\\\]|\\\\.)*)"`, "g");
  return [...code.matchAll(pattern)].map((match) => JSON.parse(`"${match[1]}"`) as string).filter((key) => HAN.test(key));
}

const rendererFiles = readdirSync(new URL("../../src/desktop/renderer/", import.meta.url))
  .filter((name) => name.endsWith(".ts") && !["messages-en.ts", "i18n.ts", "global.d.ts"].includes(name));

test("system language tags choose Chinese only for Chinese", () => {
  for (const tag of ["zh", "zh-CN", "zh_CN.UTF-8", "zh-Hans", "ZH-tw"]) assert.equal(localeFromLanguageTag(tag), "zh-CN", tag);
  for (const tag of ["en-US", "C", "", undefined, "zhx", "de-DE"]) assert.equal(localeFromLanguageTag(tag), "en", String(tag));
});

test("messages fill named placeholders and fall back to the Chinese source", () => {
  assert.equal(formatMessage("{count} 个文件 · {missing}", { count: 3 }), "3 个文件 · {missing}");
  assert.equal(translateMessage({ "共 {n} 项": "{n} items" }, "en", "共 {n} 项", { n: 2 }), "2 items");
  assert.equal(translateMessage({}, "en", "未翻译 {n}", { n: 1 }), "未翻译 1");
  assert.equal(translateMessage({ "共 {n} 项": "{n} items" }, "zh-CN", "共 {n} 项", { n: 2 }), "共 2 项");
});

test("every Chinese renderer message has an English translation", () => {
  const missing = rendererFiles.flatMap((name) => calledKeys(source(`renderer/${name}`), "t")
    .filter((key) => !Object.hasOwn(EN_MESSAGES, key)).map((key) => `${name}: ${key}`));
  assert.deepEqual(missing, []);
});

test("renderer code writes Chinese interface text only through t()", () => {
  const untranslated = rendererFiles.flatMap((name) => withoutComments(source(`renderer/${name}`)).split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => HAN.test(line.replace(/\bt\(\s*"(?:[^"\\]|\\.)*"/g, "")))
    .map(({ line, number }) => `${name}:${number}: ${line.trim()}`));
  assert.deepEqual(untranslated, []);
});

test("every Chinese string in the window markup has an English translation", () => {
  const html = source("renderer/index.html").replace(/<(script|style)[\s\S]*?<\/\1>/g, "");
  const texts = [
    ...[...html.matchAll(/(?:title|aria-label|placeholder)="([^"]*)"/g)].map((match) => match[1] ?? ""),
    ...[...html.matchAll(/>([^<>]+)</g)].map((match) => (match[1] ?? "").replace(/\s+/g, " ").trim()),
  ].filter((text) => HAN.test(text));
  const contextual = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1] ?? "");
  assert.ok(texts.length > 100, "the scan found the window's labels");
  assert.deepEqual([...texts, ...contextual].filter((text) => !Object.hasOwn(EN_MESSAGES, text)), []);
});

test("English text is English and keeps every placeholder", () => {
  for (const dictionary of [EN_MESSAGES, MAIN_EN_MESSAGES]) {
    for (const [key, value] of Object.entries(dictionary)) {
      assert.ok(value.trim(), `empty translation for ${key}`);
      assert.ok(!HAN.test(value), `Chinese left in the translation of ${key}`);
      assert.deepEqual(placeholders(value), placeholders(key.split("#")[0] ?? ""), key);
    }
  }
});

test("every Chinese main-process message has an English translation", () => {
  const files = ["main.ts", "application.ts", "local-path.ts", "system-open.ts", "article-export.ts"];
  const missing = files.flatMap((name) => calledKeys(source(name), "mt")
    .filter((key) => !Object.hasOwn(MAIN_EN_MESSAGES, key)).map((key) => `${name}: ${key}`));
  assert.deepEqual(missing, []);
});

test("main-process messages follow the language the window reports", () => {
  try {
    assert.equal(initialInterfaceLocale("en-US", undefined), "en");
    assert.equal(mt("已取消导出"), "Export cancelled");
    assert.equal(initialInterfaceLocale("en-US", "zh-CN\n"), "zh-CN");
    assert.equal(mt("已取消导出"), "已取消导出");
    assert.equal(setInterfaceLocale("fr"), undefined);
    assert.equal(setInterfaceLocale("en"), "en");
    assert.equal(mt("已导出 {path}", { path: "/tmp/a.txt" }), "Exported /tmp/a.txt");
  } finally {
    setInterfaceLocale("zh-CN");
  }
});
