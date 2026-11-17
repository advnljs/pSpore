# Module: Notifications

## 职责与入口

- `src/notifications/notification-service.ts`：有界持久通知列表，agent notify 与自动化 run 投递，初始化从 JSONL 恢复。
- `src/notifications/notification-tools.ts`：Agent 的 notify 工具，附带来源 session；`src/daemon/daemon.ts` 把通知提交到 kernel 并通过协议广播。
- `src/desktop/desktop-notifications.ts`：Electron 主进程接收、托盘、关闭隐藏、独立卡片、定时器和安全跳转。
- `src/desktop/notification-model.ts`：无 Node 的会话解析/坐标/去重，历史列表复用解析函数。
- `src/desktop/notification/{index.html,styles.css,notification.ts,preload.cjs}`：沙箱卡片；`notification-contract.ts` 定义最小类型。

## 数据流与接口

`notify / run delivery → NotificationService → kernel notification.created → UDS → DaemonBridge → DesktopNotifications → popup`。

- 首次 snapshot 只建立已见集合；实时事件与重连 snapshot 只显示新 id。前台已聚焦时标记已见但不弹窗；新通知覆盖同一张卡片并累计数量。
- 卡片 12 秒自动隐藏，悬停或键盘焦点暂停，离开后重新计时；恢复工作区时清除卡片。
- `current/act/subscribe` 是通知 preload 的全部 API；act 仅 open/dismiss/pause/resume，必须匹配当前 notification id。主进程校验 sender、顶层 frame 和文件 URL。
- 跳转优先 explicit target session，其次 agent 来源 session，其次 `run:<runId>`；已删除/不存在时打开活动通知历史，不随意跳转其他会话。
- 展示继承当前主界面语言与 localStorage 主题；原文用 textContent，限制行数，尊重 reduced-motion。

## 依赖、边界与修改点

- 复用 Electron 43、既有 DaemonBridge、安全策略与品牌图标；无新增生产依赖。
- 正常关闭隐藏主窗口；托盘退出与系统退出清理 shell，生产 systemd Daemon 仍继续。
- 桌面接收端需至少启动一次，显式退出/从未启动时不弹窗；不改系统登录启动配置。
- X11 实测，Wayland compositor 可能限制窗口坐标/激活，目标麒麟环境需复验；托盘实际展示还取决于系统托盘宿主。
- 改颜色/间距在 notification/styles.css；改时长须同步主进程 DISPLAY_MS 与 CSS countdown；改路由只改 notificationSession。
- 回归：`test/unit/desktop-notifications.test.ts` 和 `scripts/notification-smoke.mjs` / `npm run test:notifications`。
