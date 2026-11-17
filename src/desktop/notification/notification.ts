/// <reference lib="dom" />
import type { NotificationCard, NotificationCardApi } from "../notification-contract.js";

declare global { interface Window { psporeNotification: NotificationCardApi; } }
const api = window.psporeNotification;
const card = document.querySelector<HTMLElement>(".card")!;
const open = document.querySelector<HTMLButtonElement>("#open")!;
const dismiss = document.querySelector<HTMLButtonElement>("#dismiss")!;
let current: NotificationCard | undefined;
let hovered = false;
let focused = false;
const text = (id: string, value: string): void => { document.getElementById(id)!.textContent = value; };

function render(value: NotificationCard): void {
  current = value;
  const en = value.locale === "en";
  document.documentElement.lang = value.locale;
  try { document.documentElement.dataset["theme"] = localStorage.getItem("pspore.desktop.theme") === "dark" ? "dark" : "light"; }
  catch { document.documentElement.dataset["theme"] = "light"; }
  card.dataset["level"] = value.level;
  text("label", en ? "Your local assistant" : "你的本地助手");
  text("level", ({ info: en ? "New update" : "最新消息", success: en ? "Completed" : "已完成", warning: en ? "Needs attention" : "需要关注", error: en ? "Something went wrong" : "遇到问题" })[value.level]);
  text("count", value.count > 1 ? (en ? `${value.count} new` : `${value.count} 条新通知`) : "");
  const date = new Date(value.ts);
  text("time", Number.isNaN(date.valueOf()) ? "" : date.toLocaleTimeString(value.locale, { hour: "2-digit", minute: "2-digit", hour12: false }));
  text("title", value.title); text("body", value.body); text("session", value.sessionTitle);
  document.getElementById("title")!.title = value.title;
  document.getElementById("session")!.title = value.sessionTitle;
  text("open-label", value.hasSession ? (en ? "Open session" : "进入会话") : (en ? "View notifications" : "查看通知"));
  dismiss.title = dismiss.ariaLabel = en ? "Dismiss notification" : "关闭通知";
  open.disabled = false;
  resetTimer();
  if (hovered || focused) void act("pause");
  document.documentElement.dataset["ready"] = "true";
}

function resetTimer(): void { document.querySelector(".timer")!.replaceChildren(document.createElement("i")); }
async function act(action: "open" | "dismiss" | "pause" | "resume"): Promise<void> {
  if (!current) return;
  try { await api.act(action, current.id); }
  catch { if (action === "open") { open.disabled = false; text("open-label", current.locale === "en" ? "Try again" : "重试打开"); } }
}
function updatePause(): void {
  if (!hovered && !focused) resetTimer();
  void act(hovered || focused ? "pause" : "resume");
}
open.addEventListener("click", () => { open.disabled = true; void act("open"); });
dismiss.addEventListener("click", () => { void act("dismiss"); });
card.addEventListener("mouseenter", () => { hovered = true; updatePause(); });
card.addEventListener("mouseleave", () => { hovered = false; updatePause(); });
card.addEventListener("focusin", () => { focused = true; updatePause(); });
card.addEventListener("focusout", (event) => { focused = event.relatedTarget instanceof Node && card.contains(event.relatedTarget); updatePause(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    hovered = false; focused = false;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }
});
window.addEventListener("blur", () => { focused = false; updatePause(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") void act("dismiss"); });
const unsubscribe = api.subscribe(render);
window.addEventListener("beforeunload", unsubscribe, { once: true });
void api.current().then((value) => { if (value && !current) render(value); });
