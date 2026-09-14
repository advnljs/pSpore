import assert from "node:assert/strict";
import test from "node:test";

import { initialIndexingStatus, type IndexingStatus } from "../../src/domain/indexing.js";
import { formatElapsed, presentIndexing } from "../../src/desktop/renderer/indexing-view.js";

const NOW = Date.parse("2026-09-14T08:10:00.000Z");

function status(overrides: Partial<IndexingStatus>): IndexingStatus {
  return { ...initialIndexingStatus(), enabled: true, directories: ["/home/ccb/文档"], ...overrides };
}

const LAST_PASS = {
  finishedAt: "2026-09-14T07:40:00.000Z",
  durationMs: 754_000,
  processed: 0,
  skipped: 12_345,
  failed: 0,
};

test("a silent directory walk shows a moving bar and a clock instead of an empty bar", () => {
  const early = presentIndexing(status({ phase: "scanning", startedAt: "2026-09-14T08:09:55.000Z" }), NOW);
  assert.equal(early.phaseLabel, "扫描中");
  assert.equal(early.percent, undefined);
  assert.equal(early.counts, "正在扫描目录 · 已用时 5 秒");
  assert.equal(early.ticking, true);
  assert.doesNotMatch(early.note, /几分钟/);

  // Minutes in, with a previous pass: say why nothing is counted, and that search still works.
  const long = presentIndexing(status({ phase: "scanning", startedAt: "2026-09-14T08:06:30.000Z", lastPass: LAST_PASS }), NOW);
  assert.equal(long.counts, "正在扫描目录 · 已用时 3 分 30 秒");
  assert.match(long.note, /扫描可能需要几分钟/);
  assert.match(long.note, /上次完成于 .+，此前的索引仍可搜索/);

  const comparing = presentIndexing(status({ phase: "comparing", startedAt: "2026-09-14T08:09:00.000Z" }), NOW);
  assert.equal(comparing.phaseLabel, "比对中");
  assert.equal(comparing.percent, undefined);
  assert.equal(comparing.counts, "正在比对文件变化 · 已用时 1 分");
});

test("indexing with a known total is a real percentage, and with nothing to index is not a stalled 0%", () => {
  const indexing = presentIndexing(status({
    phase: "indexing",
    startedAt: "2026-09-14T08:09:30.000Z",
    total: 200,
    processed: 50,
    skipped: 9_000,
    failed: 2,
    currentFile: "/home/ccb/文档/报告.docx",
  }), NOW);
  assert.equal(indexing.percent, 25);
  assert.equal(indexing.counts, "50 / 200 个文件 · 未变化 9000 · 失败 2 · 已用时 30 秒");
  assert.equal(indexing.current, "/home/ccb/文档/报告.docx");

  const nothing = presentIndexing(status({ phase: "indexing", total: 0, skipped: 300 }), NOW);
  assert.equal(nothing.percent, undefined);
  assert.equal(nothing.counts, "没有需要更新的文件 · 未变化 300");
});

test("a finished pass reads as up to date even when it changed nothing, and a never-run one does not", () => {
  const upToDate = presentIndexing(status({
    phase: "idle",
    total: 0,
    lastPass: LAST_PASS,
    finishedAt: LAST_PASS.finishedAt,
    nextRunAt: "2026-09-14T08:10:00.000Z",
  }), NOW);
  assert.equal(upToDate.phaseLabel, "已是最新");
  assert.equal(upToDate.percent, 100);
  assert.equal(upToDate.counts, "没有变化 · 已检查 12345 个文件");
  assert.match(upToDate.note, /完成于 .+ · 用时 12 分 34 秒 · 下次检查 /);
  assert.equal(upToDate.ticking, false);

  const updated = presentIndexing(status({ phase: "idle", lastPass: { ...LAST_PASS, processed: 40, failed: 1 } }), NOW);
  assert.equal(updated.counts, "本次更新 40 个文件 · 未变化 12345 · 失败 1");

  const waiting = presentIndexing(status({ phase: "idle" }), NOW);
  assert.equal(waiting.phaseLabel, "空闲");
  assert.equal(waiting.percent, 0);
  assert.equal(waiting.counts, "等待首次索引");
});

test("switched-off and unusable states keep their reasons and the settings echo", () => {
  const unconfigured = presentIndexing(status({ phase: "unconfigured", directories: [], message: "本机索引已启用，但还没有选择要索引的目录" }), NOW);
  assert.equal(unconfigured.phaseLabel, "缺少目录");
  assert.equal(unconfigured.percent, 0);
  assert.equal(unconfigured.counts, "本机索引已启用，但还没有选择要索引的目录");
  assert.match(unconfigured.note, /^设置：已启用 · 在设置 → 本机索引中添加目录后开始索引$/);

  const off = presentIndexing(undefined, NOW);
  assert.equal(off.phaseLabel, "未启用");
  assert.equal(off.note, "设置：未启用");

  const failed = presentIndexing(status({ phase: "failed", total: 10, processed: 4, message: "索引目录不可读", lastPass: LAST_PASS }), NOW);
  assert.equal(failed.percent, 40);
  assert.equal(failed.counts, "中断于 4 / 10 个文件");
  assert.match(failed.note, /索引目录不可读/);
  assert.match(failed.note, /此前的索引仍可搜索/);
});

test("elapsed time is readable from seconds to hours", () => {
  assert.equal(formatElapsed(0), "0 秒");
  assert.equal(formatElapsed(59), "59 秒");
  assert.equal(formatElapsed(120), "2 分");
  assert.equal(formatElapsed(3_599), "59 分 59 秒");
  assert.equal(formatElapsed(3_600), "1 小时");
  assert.equal(formatElapsed(5_460), "1 小时 31 分");
});
