# Specifications

## 用户明确需求

1. 基于 Pi 构建自己的主动式 Agent。
2. 代码与核心算法极简，复杂能力模块解耦、配置化、可插拔。
3. 顶层生命周期与复杂子流程由一个简洁 main loop 归并，包含类似 OpenClaw `BOOT.md` 的设计。
4. 使用本地目录和若干固定文件作为常驻记忆；其余文件与聊天通过 grep/BM25 动态搜索；向量搜索默认不实现但可插拔。
5. 可接入 skills 与 MCP。
6. TUI 和 Electron UI 使用同一套底层；核心先以 TUI 验收，Electron 最后实现。
7. 首版 Linux；默认基于当前登录用户 shell 和权限运行，包括可用的 sudo；用户可选择高危询问、全部询问或完全放权。
8. 允许用户自定义 cron job。
9. 上下文 token 友好并尽可能利用 LLM API KV cache。
10. 支持 subagent，以及主/子 agent 实时双工通信。
11. 与用户保持实时双工通信。
12. 多轮校核并完成详细设计。
13. 完成后自动提交到 GitHub 同名 `pSpore` 私有仓库。

## 约束与偏好

- 默认中文沟通，技术标识保持英文。
- 核心功能先通过 TUI 开发与验收；桌面客户端最后实现。
- 放弃 Tauri，桌面客户端固定使用 Electron 43；项目运行时基线固定为 Node.js 24。
- 当前已进入实现阶段；只汇报真实代码、build、测试和服务状态。
- 首版 local-first、单用户、Linux-first；公网 Web、多租户、vector 和 mobile 不自行扩 scope。
- `allow_all` 的风险必须明确，不得把 in-process policy 宣称为 sandbox。
- Pi 上游以 2026-08-09 核对到的 `v0.84.1` 为设计基线，实现前需 contract spike。
- 新增生产依赖必须另行征求用户确认。
- 用户已确认当前实现依赖，并允许安装/下载时使用中国大陆相关镜像源；不得因此静默改写全局 npm 配置。
- 用户已明确授权在其休息期间不等待新指令，在现有范围与安全边界内持续开发，直到 v1 完成。
- 2026-08-11 桌面优化必须简洁大气，支持深色/浅色模式切换，并重点实际验证字号与可读性。
- 本轮明确只做 PC Electron 桌面端，不做手机端或移动 viewport 验收。
- AppImage 双击启动后不得因为缺失 `~/.pspore/run/daemon.sock` 无限等待；必须自动初始化/启动或安全复用 Daemon。
- 使用用户提供但不得提交/输出的 `ds_key.txt` 实际验证 `deepseek-v4-flash`。
- 桌面界面重新设计前可用 image generation 比较多种风格；最终不要高信息密度，应简洁大气。所谓高利用率是修复侧栏长期占位、上下区块失衡和无意义空区，不是缩小字号或塞满信息。
- PC Electron 主工作区必须配合窗口缩放响应式调整；不增加手机布局。辅助检查器应按需展开，会话与输入保持稳定可见。
- 设置菜单至少支持 LLM provider、model、Base URL、API Key、API 兼容类型与 thinking；Key 不得回读明文、进入日志、会话、memory 或 Git。
- GUI 与 TUI 的 Provider 选择必须精确提供 `deepseek`、`openai`、`custom-openai`（中文显示“自定义 OpenAI”），不暴露其他 Provider。
- TUI 模型配置必须同时支持 launch wizard 与命令方式；wizard 可取消且确认前不持久化，命令方式可直接设置同一共享配置。
- TUI/CLI 与桌面版必须基于相同 Kernel、Daemon、协议状态、会话路由和模型设置内核，功能面覆盖 prompt、main/child、审批、自动化、MCP、资源与设置；平台渲染组件可以独立。
- CLI/TUI 必须可以从 npm 直接安装使用；npm CLI 包不应把 Electron 作为生产依赖。如需发布认证，使用 npm 浏览器认证，不读取或粘贴 token。
- 用户明确选定公开 npm 包名 `p-spore`；安装后的全局 CLI 命令保持为 `pspore`。

## 设计验收标准

- 详细设计覆盖系统边界、模块、接口、状态机、数据、权限、异常、恢复、验证和路线图。
- 原始 11 条思路均有明确落点或工程修正，不能只做概念扩写。
- TUI/Electron 的“同底层”和用户/agent 双工有协议级定义。
- cron、BOOT 与外部副作用的去重/故障语义明确。
- subagent 有预算、权限继承、取消、文件并发和消息路由定义。
- token/KV cache 有稳定前缀、动态上下文与真实指标策略。
- Electron 后置阶段视觉测试主基准为 `1920 × 1080`；核心 v1 使用固定 `160 × 45` TUI snapshot，未要求时不扩展设备矩阵。
- Electron renderer 必须保持 `contextIsolation + sandbox`、关闭 Node integration，只暴露固定 allowlisted API；外部导航、新窗口、下载、远程 script 和任意 channel/path IPC 均不得开放。
- Electron 验收必须覆盖与 TUI 同时连接同一 Daemon、断线重连、streaming delta、长消息/代码 overflow、transcript scroll、工具输出折叠、固定 composer、审批 modal 与焦点。
- 桌面 smoke 还必须覆盖 owned/external Daemon 两种启动路径、深色/浅色截图和计算后字号下限；本轮不扩展移动端矩阵。
- 响应式桌面验收在 `1920×1080` 主基准通过后，补测 `1440×900` 与 `1180×720`；三档均不得产生 document overflow，composer 必须完整可见，窄窗口检查器以受控抽屉呈现。
- 设置弹层必须留在 viewport 内、锁定背景焦点、API Key input 保持 password，read API 只返回 `hasApiKey` 状态。
- TUI 主基准 `160×45` 必须保持简洁双栏、完整输入和可访问命令；补测 `96×30` 单栏，不要求手机端。完整命令经 `/help` 展示，不用常驻高密度底栏。
- npm tarball 只能包含运行需要的 README、`dist` 与 package metadata；全新 prefix 安装后 bin 必须可执行，并能从仓库外启动 TUI、自动管理 Daemon。
- 全局安装后必须存在与包名一致的 `p-spore` 命令；`pspore` 作为等价短命令保留，两者指向同一入口。
- npm 展示页（根 `README.md`）必须为英文，且面向 p-spore CLI 自身功能与用法，不放项目记忆、开发流程或阶段进度；中文项目文档放在 `docs/project-overview.md`。
- p-spore CLI（含 TUI）的用户可见文案必须为英文。
- memory-bank 完整同步。
- GitHub 仓库必须是同名私有仓库；提交前检查敏感信息与范围。
