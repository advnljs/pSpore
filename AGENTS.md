# pSpore 项目约定

- 开始工作前阅读 `memory-bank/specs.md`、`nav.md` 和相关模块记录；遵循其中的项目约束与验证流程。
- 用户要求：以后每次更新 p-spore，都必须同步更新公开 npm 包 `p-spore`，不能只发布 GitHub Release。npm 发布与远端实装验证是更新完成的必要条件；仅记录进度或修改项目文档不重复发版。
- 发布前同步 `package.json`、`package-lock.json`、`src/version.ts` 与构建产物版本，运行 `npm run check`；保留已发布版本和 tag 的不可变性。若当前代码版本尚未发布 npm，可补发该版本；若 npm 已存在且代码变化，必须先升版。
- npm tarball 从通过检查且与 Git 一致的 `dist/`、`package.json`、`README.md`、`LICENSE` 生成；排除未跟踪内容和桌面打包缓存（尤其 `bundled-skills/*/bin/` 下本机下载的原生二进制）。在仓库外全新 prefix 安装并验证 `p-spore`、`pspore` 命令与隔离 Daemon；发布后核对 registry 版本、`latest` 和 tarball 校验值，再从 registry 全新安装复验。
- 项目使用 MIT 许可证；根 README 默认英文，顶部提供 `README.zh-CN.md` 链接。公开截图使用演示数据，不能包含凭据或用户私有内容。
- npm 登录或发布需要授权时，在交互终端使用 npm web 认证并打开浏览器让用户授权；不得要求用户粘贴 token/OTP，不读取或记录认证秘密。先完成构建和验证，再触发短时效的发布授权。
- 将 npm 实际发布状态与验证证据同步到 `memory-bank/`。授权未完成或发布失败时明确报告，不能把 GitHub Release 成功当作 npm 发布成功。
