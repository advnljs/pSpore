# p-spore

[English](README.md) · 简体中文

pSpore 是优先面向 Linux 的本地 AI 工作助手，提供桌面 GUI、终端 TUI 和 CLI。会话、长期记忆、定时任务与子 Agent 由同一个本地守护进程管理；关闭窗口后，后台任务仍可继续。项目基于 [Pi](https://github.com/earendil-works/pi)，采用 [MIT 许可证](LICENSE)开源。

**pSpore 非常适合用于信创 PC**：面向 Linux 桌面办公，提供 x86_64 和 ARM64 发行包，ARM64 构建以银河麒麟 V10、飞腾平台的 glibc 2.31 环境为适配目标。可连接自建的 OpenAI 兼容模型服务，处理本机文档、文件和日常工作任务。

## 界面预览

以下截图来自实际运行的桌面客户端，使用演示数据，分辨率为 `1920 × 1080`。

![pSpore 浅色桌面工作区](docs/images/desktop-light.png)

![pSpore 深色桌面工作区](docs/images/desktop-dark.png)

## 主要功能

- **本地工作区与持久会话**：对话保存在本机，服务重启后恢复；可并行管理多个会话。
- **文件与文档处理**：读取文本、Word、Excel、PowerPoint、PDF；支持 UTF-8、UTF-16 和 GB18030 文本。
- **长文写作**：独立文稿面板、流式正文、版本对比，以及 TXT、Markdown、DOCX、PDF 导出。
- **可追踪的工具过程**：查看工具名称、输入、执行结果与失败原因；完成的过程可折叠，长上下文可自动压缩。
- **长期任务与协作**：定时任务、子 Agent、通知、MCP、Skills 和插件使用同一守护进程。
- **模型接入**：支持 DeepSeek、OpenAI 和自建 OpenAI 兼容端点，可选择 Chat Completions 或 Responses 协议。

## 桌面版安装

在 [GitHub Releases](https://github.com/advnljs/pSpore/releases/latest) 下载与机器架构匹配的完整桌面 ZIP：

| 机器架构 | 文件名中的架构标识 |
|---|---|
| x86_64 / AMD64 | `linux-x64` |
| ARM64 / AArch64 | `linux-arm64` |

解压完整安装包，执行其中的 `创建桌面快捷方式.sh`，再通过桌面或应用菜单启动 pSpore。完整包携带 Electron/Chromium 运行时。

后续可使用对应架构的 overlay 升级包，运行 `./覆盖升级.sh /原安装目录`。升级程序先检查运行时与架构是否兼容，再替换应用文件；用户数据保留在 `~/.pspore`。每个正式版本的下载资产都提供 SHA-256 校验文件。

## 终端版安装

需要 Linux、**Node.js 24**（`>=24.0.0 <25`）和可用的 systemd 用户服务（`systemctl --user`）。文件搜索使用 `ripgrep`，可通过 `p-spore doctor` 检查环境。

```bash
npm install --global p-spore
p-spore tui
```

`p-spore` 和 `pspore` 是两个等价命令。只想先查看用法时，可运行：

```bash
npx p-spore --help
```

TUI 首次启动会初始化数据目录，安装并启动用户级后台服务。TUI 和 GUI 都是可重连的客户端，退出客户端不会停止后台任务。WSL 或精简容器需要先提供可用的 systemd 用户服务。

**npm 包不包含 Electron 运行时。** 桌面用户请下载上面的完整桌面 ZIP；单独安装 npm 包不能直接获得完整 GUI 运行环境。

## 配置模型

首次打开 TUI 会提示进入设置向导，也可运行 `p-spore setup`，或在 TUI 输入 `/config wizard`。桌面版使用右上角设置按钮。

```bash
p-spore config show
p-spore config set deepseek deepseek-v4-flash off
p-spore config set custom-openai my-model https://gateway.example.com/v1 chat off
p-spore config key
p-spore service restart
```

`config key` 通过隐藏输入读取 API Key。密钥和可选代理 Cookie 保存在 `~/.pspore/credentials/` 的私有文件中，不应写入命令参数、项目文件或 Git。默认没有配置模型；完成配置后才能向模型发送任务。

自动压缩上下文默认开启，可在 GUI 设置或 TUI 的 `/config compact` 中调整，也可使用 CLI：

```bash
p-spore config compact on 16384 20000 100000
```

三个数字依次表示预留 token、压缩后保留的近期 token 和直接触发阈值。当前上下文与累计用量分别展示。

## 常用操作

```bash
p-spore doctor                       # 环境检查
p-spore status                       # 后台服务状态
p-spore sessions                     # 会话列表
p-spore session new "工作计划"        # 新建会话
p-spore prompt "整理今天的工作记录"   # 提交任务
p-spore jobs                         # 定时任务
p-spore runs                         # 执行记录
p-spore notifications                # 通知
p-spore skills                       # Skills 状态
p-spore mcp list                     # MCP 配置与连接状态
p-spore service logs                 # 服务日志
```

TUI 常用命令包括 `/help`、`/new`、`/select ID`、`/config`、`/skills`、`/jobs`、`/back` 和 `/quit`。桌面版支持会话搜索、文件路径拖入输入框、本地文件打开与目录定位，以及可拖动的文稿分屏。

自己的 Skills 可放入 `~/.pspore/workspace/skills/`，每个 Skill 使用 `SKILL.md` 描述。MCP 服务在 `config.json` 中配置，凭据通过引用提供。更多命令见[英文 README](README.md)。

## 数据与权限

- 会话、配置和工作区默认位于 `~/.pspore`；可用 `--home PATH` 或 `PSPORE_HOME` 指定其他目录。
- 客户端通过本机 Unix domain socket 连接守护进程，不需要 pSpore 托管后端。使用远端模型时，任务上下文会发送至所配置的模型服务。
- 默认 `ask_risky` 策略对高风险操作请求批准；也可配置 `ask_all` 或 `deny`。
- 工具以启动服务的用户身份运行，pSpore 不是操作系统沙箱。`allow_all` / `bypass` 会跳过审批，仅适用于你信任的工作环境。
- 支持 Office 与 PDF 文本抽取；WPS 私有 `.wps`、`.et`、`.dps` 请先另存为标准 Office 格式，扫描版 PDF 需要另行 OCR。

## 链接与许可证

- [源码仓库](https://github.com/advnljs/pSpore)
- [桌面版下载](https://github.com/advnljs/pSpore/releases)
- [npm 包](https://www.npmjs.com/package/p-spore)
- [问题反馈](https://github.com/advnljs/pSpore/issues)
- [中文项目说明](docs/project-overview.md)

本项目采用 [MIT 许可证](LICENSE)。第三方依赖遵循各自的许可证。
