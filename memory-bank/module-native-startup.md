# Native startup

## 职责与边界

- 让桌面/任务栏点击后的第一个 loading 窗口独立于 Electron 启动耗时。512 × 332 无边框 GTK3/Cairo/Pango 卡片复用图标与现有配色；PC 主基准 1920 × 1080。
- 只管理自己启动的 Electron 子进程及其进程组；不直接调用 systemctl，不读取工作区内容、模型或用户设置。

## 入口与文件

- `src/desktop/native/startup.c`：独立原生入口、绘图、abstract socket、信号/子进程监控。
- `src/desktop/native-startup.ts`：Electron 端连接、状态文本与聚焦处理；`main.ts` 决定原生接管或 HTML 回退。
- `scripts/build-native-startup.sh`：本机架构 C 编译，无额外 npm 依赖。
- `scripts/native-startup-smoke.mjs`：五秒延迟、帧顺序、参数、重复点击、交接、取消、失败真实 X11 测试。
- `scripts/linux/create-desktop-shortcut.sh`：稳定入口优先执行原生 ELF，旧包无 ELF 则直启 Electron。
- `scripts/package-desktop.sh`、`apply-overlay-upgrade.sh`：随 `resources/` 分发与恢复执行位，升级后刷新已安装的稳定 launcher。

## 接口与生命周期

1. 参数为绝对 Electron 路径及原样参数数组，绝不经 shell 拼接执行。
2. 以 UID + XDG config 目录 SHA-256 前 24 位组成 abstract socket 名；第二次启动发 `ACTIVATE` 后退出，已有进程聚焦当前窗口。
3. GTK `after-paint` + `gdk_display_sync` 后 `g_spawn_async`；环境传入 `PSPORE_STARTUP_SOCKET`。
4. 子进程经 `HELLO/WELCOME` 连接；发 `STATUS <单行 UTF-8>` 更新状态，发 `HIDE` 交给主界面。启动器保留轻量事件循环，用 `FOCUS` 处理后续任务栏激活。
5. 所有 peer 必须同 UID；控制 peer PID 必须等于直接 Electron 子进程。最多 16 连接、每条最多 1023 bytes、未握手 10 秒超时；客户端握手 1 秒超时回退。
6. Esc/关闭：立即隐藏 loading，SIGTERM 该子进程组，3 秒后 SIGKILL 兜底，回收子进程；意外失败在交接前显示可关闭错误状态。

## 依赖与约束

- Linux GTK 3.24 / GLib 2.64 / Cairo / Pango，均属于现有 Electron 系统运行时依赖。GTK 自动适配 X11/Wayland。当前自动化视觉证据为 X11，目标麒麟/Wayland 仍需实机复验。
- 构建依赖 `libgtk-3-dev pkg-config`；ARM64 使用现有 Ubuntu 20.04 / glibc 2.31 原生构建。
- ELF 必须放 `resources/native/pspore-startup`，不得覆盖顶层 `pspore-desktop` 或破坏 overlay Electron runtime 契约。
- 改图标/尺寸时同步原生卡片与 `splash/` 回退卡片；改协议时同步 C 与 TypeScript 客户端及真实进程测试。

- CI 的 Ubuntu 20.04 默认 ASCII locale：窗口查询必须使用 `LC_ALL=C.UTF-8` 才能读取中文标题。测试只改变查询进程编码，保留原生启动器的原始运行环境。
- 原生视觉测试必须等待窗口 `IsViewable`，X11 树中出现标题并不表示窗口已经映射；保留尺寸和可见性断言。
