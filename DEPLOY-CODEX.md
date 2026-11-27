# Codex 独立机器人部署

版本：`2026.11.24-codex.1`。Codex 桌面和 Lark 都能聊天，各自保存对话，不同步记忆。

## 本机配置

1. 安装 Node.js 22 或更新版本、Lark CLI 和 Codex CLI。当前版本以 Windows 为部署目标。
2. 为 Codex 使用独立的 Lark 应用。已运行其他机器人时不要复用它们的应用配置。
3. 新设备上将 `config.codex.example.json` 复制为 `config.json`，填写自己的 `allowedOpenId`、独立的 `larkProfile` 和可选 `codexExe`。已有配置时保留原文件。
4. 建立同名 Lark 配置，例如 `bot3`。新应用可使用 `lark-cli config init --new --name bot3`，按 CLI 给出的页面完成创建。如果已拥有独立应用，使用 `lark-cli config init --help` 中的 App ID / 标准输入 Secret 方式；不要把密钥写进命令、Git 或聊天。
5. 开放平台启用机器人、长连接和 `im.message.receive_v1`，按 README 开通收发消息及表情权限并发布应用版本。白名单 `open_id` 应属于这个应用。
6. 在普通 Windows 终端运行 `./codex-login.ps1` 完成机器人专用的 Codex 登录。登录及会话放在 `state/codex-home`，与桌面聊天分开。已有 Codex 桌面登录不等于这个目录已登录。
7. 运行 `./start.ps1 -Check`。确认 Lark bot 身份和 Codex 登录均已就绪，再运行 `./start.ps1` 做首次私聊测试。
8. 连续发送两条相关消息，确认 Lark 内会话可续接。默认空闲 24 小时后新开会话；`/q` 是一次性会话，`/new` 主动重置。
9. 测试通过后运行 `./install-autostart.ps1`，再运行 `./start-background.ps1`。用 `./stop.ps1` 停止这个实例。

## 版本行为

### 在 Lark 切换模型

- `/model` 查看当前聊天的模型和推理强度。
- `/model astra` 切换到 GPT-6.2 Astra，默认使用 `high` 推理。`/model sol` 切换到 GPT-6.2 Sol，默认使用 `medium`。
- `/model astra xhigh` 可指定推理强度。命令接受 `low`、`medium`、`high`、`xhigh`。
- `/model default` 恢复 `config.json` 中的 `codexModel` 和 `codexEffort`。如果 `codexModel` 留空，新对话使用 Codex CLI 默认模型。
- 设置按 Lark 聊天保存，重启后仍有效，并继续现有对话。群聊中仍需 @ 机器人。`/q` 继续使用独立的快速模式。

### 启动与运行

- 启动前只读检查 Lark 应用身份和 Codex 登录。缺少 `bot3` 等配置时返回退出码 3，守护脚本停止，不反复重连或切换成别的机器人。
- Codex 默认使用 `persona.codex.md`；本机 `persona.local.md` 仍优先。
- `node bridge.js --version` 无需配置即可显示版本号。
- `npm test` 无需真实 Lark / Codex 登录，不发送消息或修改在线数据。
- 工具通路仍是 `lark-mcp.js` → Lark CLI；保持现有 shell 禁用策略和发送人白名单。

## Git 交付、升级和回退

本版本在 `codex/lark-cli-deployment` 分支，标签为 `v2026.11.24-codex.1`。安装到新目录可以：

```powershell
git clone --branch v2026.11.24-codex.1 https://github.com/ericzhang8090/lark-bridge.git lark-bridge-codex
cd lark-bridge-codex
Copy-Item config.codex.example.json config.json
```

配置、登录和白名单需在本机完成；源代码下载不携带个人登录数据。现有实例升级前停止这个实例、备份 `config.json` 和 `state`，检查工作区无未保存源码修改，再切换到版本标签。回退时切回此前的代码版本，保留本机配置和会话数据。

`./package-release.ps1` 用 `git archive` 从当前提交生成 ZIP，并生成 SHA-256 校验文件。它不会打包忽略的配置、密钥、会话、日志或附件。压缩包在 `artifacts/`，不提交到 Git。
