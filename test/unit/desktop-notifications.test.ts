import assert from "node:assert/strict";
import test from "node:test";
import { initialKernelState } from "../../src/kernel/state.js";
import type { NotificationRecord } from "../../src/notifications/notification-service.js";
import { NotificationFeed, notificationBounds, notificationSession } from "../../src/desktop/notification-model.js";
import { createDesktopSmokeState } from "../../src/desktop/smoke-fixture.js";
import { DesktopStore } from "../../src/desktop/renderer/store.js";

const notification = (id: string): NotificationRecord => ({ version: 1, id, ts: new Date().toISOString(),
  level: "info", title: "Update", body: "Ready", source: { kind: "agent", sessionId: "main" }, target: { kind: "local-notification" } });

test("notification feed skips initial history and deduplicates replay while recovering offline arrivals", () => {
  const feed = new NotificationFeed();
  const old = notification("old");
  const first = notification("first");
  const offline = notification("offline");
  assert.deepEqual(feed.accept([old]), []);
  assert.deepEqual(feed.accept([old, first]), [first]);
  assert.deepEqual(feed.accept([old, first]), []);
  assert.deepEqual(feed.accept([old, first, offline]), [offline]);
  assert.deepEqual(feed.accept([old]), []);
  assert.deepEqual(feed.accept([old, first, offline]), []);
});

test("notification route prioritizes explicit target, then agent/run source, and never guesses a missing session", () => {
  const state = createDesktopSmokeState(initialKernelState(), false);
  const main = state.sessions["main"]!;
  state.sessions = { ...state.sessions, other: { ...main, sessionId: "other" }, "run:job-1": { ...main, sessionId: "run:job-1" } };
  const record = notification("n");
  assert.equal(notificationSession(record, state), "main");
  record.target = { kind: "session", sessionId: "other" };
  assert.equal(notificationSession(record, state), "other");
  assert.equal(notificationSession(record, { ...state, sessions: { main } }), undefined);
  record.target = { kind: "local-notification" };
  record.source = { kind: "run", runId: "job-1" };
  assert.equal(notificationSession(record, state), "run:job-1");
  record.source = { kind: "agent", sessionId: "__proto__" };
  assert.equal(notificationSession(record, state), undefined);
});

test("notification navigation uses an existing session and safely ignores deleted targets", () => {
  const store = new DesktopStore();
  const state = createDesktopSmokeState(initialKernelState(), false);
  state.sessions = { ...state.sessions, destination: { ...state.sessions["main"]!, sessionId: "destination" } };
  store.applyFrame({ version: 1, kind: "snapshot", snapshot: state, cursors: {} });
  store.applyFrame({ version: 1, kind: "notification.open", sessionId: "destination" });
  assert.equal(store.snapshot().selectedSessionId, "destination");
  store.applyFrame({ version: 1, kind: "notification.open", sessionId: "deleted" });
  assert.equal(store.snapshot().selectedSessionId, "destination");
});

test("notification placement uses work area including taskbar and negative monitor origins", () => {
  assert.deepEqual(notificationBounds({ x: 0, y: 0, width: 1920, height: 1040 }), { x: 1472, y: 732, width: 432, height: 292 });
  assert.deepEqual(notificationBounds({ x: -1920, y: -200, width: 1920, height: 1080 }), { x: -448, y: 572, width: 432, height: 292 });
});
