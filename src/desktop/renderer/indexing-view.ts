import type { IndexingPhase, IndexingStatus } from "../../domain/indexing.js";
import { clockTime } from "../../ui/shared/presentation.js";

/**
 * What the indexing panel shows for a status, kept free of the DOM so the rules
 * can be tested. The panel used to show an empty bar and "正在扫描目录…" for as
 * long as the CLI walked the directories — which reports no counts and can take
 * minutes — and "尚未开始" after a pass that found nothing new, so a working
 * indexer read as stuck or never run.
 */
export interface IndexingView {
  phase: IndexingPhase;
  phaseLabel: string;
  /** 0–100, or undefined while the indexer cannot say how far along it is. */
  percent: number | undefined;
  counts: string;
  current: string;
  note: string;
  /** The text changes with the clock alone, so the caller has to re-render on a timer. */
  ticking: boolean;
}

const PHASE_LABEL: Record<IndexingPhase, string> = {
  disabled: "未启用",
  unconfigured: "缺少目录",
  unavailable: "不可用",
  idle: "空闲",
  scanning: "扫描中",
  comparing: "比对中",
  indexing: "索引中",
  failed: "失败",
};

/** Why a switched-on indexer is not making progress, in the panel's own words. */
const IDLE_REASON: Partial<Record<IndexingPhase, string>> = {
  disabled: "未启用本机索引",
  unconfigured: "已启用，但还没有选择要索引的目录",
  unavailable: "已启用，但本次发行版没有可用的索引程序",
};

/** Past this, a silent walk deserves an explanation rather than just a clock. */
const LONG_SCAN_MS = 60_000;

export function presentIndexing(status: IndexingStatus | undefined, now: number): IndexingView {
  const phase: IndexingPhase = status?.phase ?? "disabled";
  const total = status?.total ?? 0;
  const processed = status?.processed ?? 0;
  const skipped = status?.skipped ?? 0;
  const failed = status?.failed ?? 0;
  const lastPass = status?.lastPass;
  const running = phase === "scanning" || phase === "comparing" || phase === "indexing";
  const elapsedMs = running && status?.startedAt ? Math.max(0, now - Date.parse(status.startedAt)) : 0;
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs >= 1_000 ? ` · 已用时 ${formatElapsed(Math.floor(elapsedMs / 1_000))}` : "";

  let phaseLabel = PHASE_LABEL[phase];
  let percent: number | undefined = 0;
  let counts: string;
  const idleReason = IDLE_REASON[phase];
  if (idleReason !== undefined) {
    counts = status?.message ?? idleReason;
  } else if (phase === "scanning") {
    percent = undefined;
    counts = `正在扫描目录${elapsed}`;
  } else if (phase === "comparing") {
    percent = undefined;
    counts = `正在比对文件变化${elapsed}`;
  } else if (phase === "indexing") {
    if (total > 0) {
      percent = Math.min(100, Math.round((processed / total) * 100));
      counts = `${processed} / ${total} 个文件 · 未变化 ${skipped} · 失败 ${failed}${elapsed}`;
    } else {
      // Nothing new was found; the CLI is only closing the pass.
      percent = undefined;
      counts = `没有需要更新的文件 · 未变化 ${skipped}${elapsed}`;
    }
  } else if (phase === "idle") {
    if (lastPass) {
      phaseLabel = "已是最新";
      percent = 100;
      counts = lastPass.processed > 0
        ? `本次更新 ${lastPass.processed} 个文件 · 未变化 ${lastPass.skipped}`
        : `没有变化 · 已检查 ${lastPass.skipped} 个文件`;
      if (lastPass.failed > 0) counts += ` · 失败 ${lastPass.failed}`;
    } else {
      counts = "等待首次索引";
    }
  } else {
    percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
    counts = total > 0 ? `中断于 ${processed} / ${total} 个文件` : "本次索引未完成";
  }

  const notes: string[] = [];
  // The settings panel is the only place indexing is switched on, so the status
  // panel repeats that switch rather than letting the phase stand in for it.
  notes.push(status?.enabled ? "设置：已启用" : "设置：未启用");
  if (phase === "unconfigured") notes.push("在设置 → 本机索引中添加目录后开始索引");
  if (phase === "failed" && status?.message) notes.push(status.message);
  else if ((status?.directories.length ?? 0) > 0) notes.push(`索引目录：${status?.directories.join("、")}`);
  if (running && (phase !== "indexing" || total === 0) && elapsedMs >= LONG_SCAN_MS) {
    notes.push("文件很多或位于网络盘时，扫描可能需要几分钟，期间没有逐个文件的进度");
  }
  if (lastPass && (running || phase === "failed")) {
    notes.push(`上次完成于 ${clockTime(lastPass.finishedAt)}，此前的索引仍可搜索`);
  }
  if (phase === "idle" && lastPass) notes.push(`完成于 ${clockTime(lastPass.finishedAt)} · 用时 ${formatElapsed(Math.round(lastPass.durationMs / 1_000))}`);
  if (phase === "idle" && status?.nextRunAt) notes.push(`下次检查 ${clockTime(status.nextRunAt)}`);

  return {
    phase,
    phaseLabel,
    percent,
    counts,
    current: phase === "indexing" ? (status?.currentFile ?? "") : "",
    note: notes.join(" · "),
    ticking: running,
  };
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3_600) {
    const minutes = Math.floor(seconds / 60);
    return seconds % 60 === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds % 60} 秒`;
  }
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分`;
}
