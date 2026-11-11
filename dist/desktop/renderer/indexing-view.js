import { clockTime } from "../../ui/shared/presentation.js";
import { t } from "./i18n.js";
const PHASE_LABEL = {
    disabled: t("未启用"),
    unconfigured: t("缺少目录"),
    unavailable: t("不可用"),
    idle: t("空闲"),
    scanning: t("扫描中"),
    comparing: t("比对中"),
    indexing: t("索引中"),
    failed: t("失败"),
};
/** Why a switched-on indexer is not making progress, in the panel's own words. */
const IDLE_REASON = {
    disabled: t("未启用本机索引"),
    unconfigured: t("已启用，但还没有选择要索引的目录"),
    unavailable: t("已启用，但本次发行版没有可用的索引程序"),
};
/** Past this, a silent walk deserves an explanation rather than just a clock. */
const LONG_SCAN_MS = 60_000;
export function presentIndexing(status, now) {
    const phase = status?.phase ?? "disabled";
    const total = status?.total ?? 0;
    const processed = status?.processed ?? 0;
    const skipped = status?.skipped ?? 0;
    const failed = status?.failed ?? 0;
    const lastPass = status?.lastPass;
    const running = phase === "scanning" || phase === "comparing" || phase === "indexing";
    const elapsedMs = running && status?.startedAt ? Math.max(0, now - Date.parse(status.startedAt)) : 0;
    const elapsed = Number.isFinite(elapsedMs) && elapsedMs >= 1_000 ? t(" · 已用时 {value}", { value: formatElapsed(Math.floor(elapsedMs / 1_000)) }) : "";
    let phaseLabel = PHASE_LABEL[phase];
    let percent = 0;
    let counts;
    const idleReason = IDLE_REASON[phase];
    if (idleReason !== undefined) {
        counts = status?.message ?? idleReason;
    }
    else if (phase === "scanning") {
        percent = undefined;
        counts = t("正在扫描目录{elapsed}", { elapsed });
    }
    else if (phase === "comparing") {
        percent = undefined;
        counts = t("正在比对文件变化{elapsed}", { elapsed });
    }
    else if (phase === "indexing") {
        if (total > 0) {
            percent = Math.min(100, Math.round((processed / total) * 100));
            counts = t("{processed} / {total} 个文件 · 未变化 {skipped} · 失败 {failed}{elapsed}", { processed, total, skipped, failed, elapsed });
        }
        else {
            // Nothing new was found; the CLI is only closing the pass.
            percent = undefined;
            counts = t("没有需要更新的文件 · 未变化 {skipped}{elapsed}", { skipped, elapsed });
        }
    }
    else if (phase === "idle") {
        if (lastPass) {
            phaseLabel = t("已是最新");
            percent = 100;
            counts = lastPass.processed > 0
                ? t("本次更新 {processed} 个文件 · 未变化 {skipped}", { processed: lastPass.processed, skipped: lastPass.skipped })
                : t("没有变化 · 已检查 {skipped} 个文件", { skipped: lastPass.skipped });
            if (lastPass.failed > 0)
                counts += t(" · 失败 {failed}", { failed: lastPass.failed });
        }
        else {
            counts = t("等待首次索引");
        }
    }
    else {
        percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
        counts = total > 0 ? t("中断于 {processed} / {total} 个文件", { processed, total }) : t("本次索引未完成");
    }
    const notes = [];
    // The settings panel is the only place indexing is switched on, so the status
    // panel repeats that switch rather than letting the phase stand in for it.
    notes.push(status?.enabled ? t("设置：已启用") : t("设置：未启用"));
    if (phase === "unconfigured")
        notes.push(t("在设置 → 本机索引中添加目录后开始索引"));
    if (phase === "failed" && status?.message)
        notes.push(status.message);
    else if ((status?.directories.length ?? 0) > 0)
        notes.push(t("索引目录：{value}", { value: status?.directories.join(t("、")) ?? "" }));
    if (running && (phase !== "indexing" || total === 0) && elapsedMs >= LONG_SCAN_MS) {
        notes.push(t("文件很多或位于网络盘时，扫描可能需要几分钟，期间没有逐个文件的进度"));
    }
    if (lastPass && (running || phase === "failed")) {
        notes.push(t("上次完成于 {value}，此前的索引仍可搜索", { value: clockTime(lastPass.finishedAt) }));
    }
    if (phase === "idle" && lastPass)
        notes.push(t("完成于 {value} · 用时 {value2}", { value: clockTime(lastPass.finishedAt), value2: formatElapsed(Math.round(lastPass.durationMs / 1_000)) }));
    if (phase === "idle" && status?.nextRunAt)
        notes.push(t("下次检查 {value}", { value: clockTime(status.nextRunAt) }));
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
export function formatElapsed(seconds) {
    if (seconds < 60)
        return t("{seconds} 秒", { seconds });
    if (seconds < 3_600) {
        const minutes = Math.floor(seconds / 60);
        return seconds % 60 === 0 ? t("{minutes} 分", { minutes }) : t("{minutes} 分 {value} 秒", { minutes, value: seconds % 60 });
    }
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    return minutes === 0 ? t("{hours} 小时", { hours }) : t("{hours} 小时 {minutes} 分", { hours, minutes });
}
//# sourceMappingURL=indexing-view.js.map