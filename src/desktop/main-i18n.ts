import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isDesktopLocale, localeFromLanguageTag, translateMessage, type DesktopLocale, type MessageParams } from "./i18n.js";

/**
 * Main-process text: dialog titles, startup status and the messages handed
 * back to the window. The window reports its language with every bootstrap,
 * which is what an in-window language switch follows; before that the last
 * reported language, then the system language, decides.
 */
let current: DesktopLocale = "zh-CN";

export function interfaceLocale(): DesktopLocale {
  return current;
}

export function setInterfaceLocale(next: unknown): DesktopLocale | undefined {
  if (!isDesktopLocale(next)) return undefined;
  current = next;
  return next;
}

/** `remembered` is the language the window last reported, when one was saved. */
export function initialInterfaceLocale(systemTag: string, remembered: string | undefined): DesktopLocale {
  const saved = remembered?.trim();
  current = isDesktopLocale(saved) ? saved : localeFromLanguageTag(systemTag);
  return current;
}

const LOCALE_FILE = "interface-locale";

/** The language the window reported last time, so the next start opens in it. */
export async function readRememberedLocale(directory: string): Promise<string | undefined> {
  try {
    return await readFile(join(directory, LOCALE_FILE), "utf8");
  } catch {
    // Nothing saved yet: the system language decides.
    return undefined;
  }
}

export async function rememberLocale(directory: string, locale: DesktopLocale): Promise<void> {
  try {
    await writeFile(join(directory, LOCALE_FILE), locale, { mode: 0o600 });
  } catch {
    // Only the next start-up card depends on it; the window has its own copy.
  }
}

export function mt(source: string, params?: MessageParams): string {
  return translateMessage(MAIN_EN_MESSAGES, current, source, params);
}

export const MAIN_EN_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  "pSpore · 正在启动": "pSpore · Starting",
  "pSpore 启动失败": "pSpore could not start",
  "无法打开工作空间。\n\n{message}\n\n可从应用快捷方式菜单打开启动日志。":
    "The workspace could not be opened.\n\n{message}\n\nThe startup log can be opened from the app shortcut's menu.",
  "正在唤醒本地助手": "Waking up your local assistant",
  "正在整理工作空间": "Getting your workspace ready",
  " 尚未选择索引目录，索引不会运行。": " No folders are chosen yet, so indexing will not run.",
  " 本次发行版未包含索引程序，索引不会运行。": " This release does not include the indexer, so indexing will not run.",
  "索引设置已保存并应用，后台服务已重启。{caveat}": "Index settings saved and applied; the background service restarted.{caveat}",
  "索引设置已保存；重启服务后生效。{caveat}": "Index settings saved; they apply after the service restarts.{caveat}",
  "选择要引用的文件夹": "Choose folders to reference",
  "选择要引用的文件": "Choose files to reference",
  "选择要索引的目录": "Choose a folder to index",
  "设置已保存并应用，后台系统服务已安全重启。{notice}": "Settings saved and applied; the background service restarted safely.{notice}",
  "设置已安全保存；当前测试使用外部 Daemon，重启后生效。{notice}":
    "Settings saved; this test uses an external daemon, so they apply after it restarts.{notice}",
  "设置已保存并应用，测试 Daemon 已安全重启。{notice}": "Settings saved and applied; the test daemon restarted safely.{notice}",
  " 授权确认已绕过：工具会以当前用户权限直接执行。": " Approvals are bypassed: tools run directly with the current user's permissions.",
  "无效的本地路径": "Invalid local path",
  "无效的打开方式": "Invalid open action",
  "只支持本机 file:// 链接": "Only local file:// links are supported",
  "只支持绝对本地路径": "Only absolute local paths are supported",
  "文件或目录不存在，或无法访问": "The file or folder does not exist or cannot be accessed",
  "只支持普通文件和目录": "Only regular files and folders are supported",
  "可执行文件不能通过对话链接直接打开": "Executable files cannot be opened from a conversation link",
  "系统打开器无法识别这个路径": "The system opener did not recognize this path",
  "系统缺少打开此文件所需的工具": "The system is missing the tool needed to open this file",
  "没有可用于打开此文件的程序，可右键选择打开所在目录": "No application can open this file; right-click to show it in its folder instead",
  "系统打开器退出码 {code}": "The system opener exited with code {code}",
  "未找到 {command}": "{command} was not found",
  "纯文本": "plain text",
  "导出版本无效": "Invalid export version",
  "没有找到这一版文稿": "This version of the document was not found",
  "导出{format}": "Export {format}",
  "已取消导出": "Export cancelled",
  "已导出 {path}": "Exported {path}",
  "文稿": "Document",
});
