# 小八：飞书私人机器人桥接

把飞书机器人收到的消息交给本机的 Claude Code 处理，Claude 用 lark-cli 完成任务后，再以机器人身份回复。

## 工作原理

```
飞书 ──长连接──> lark-cli event consume im.message.receive_v1 --as bot   (每行输出一条 JSON 事件)
                        │
                  bridge.js（Node 常驻进程，无 npm 依赖）
                   ├─ 过滤：只接收白名单 open_id 发来的消息
                   │         · 单聊：直接处理
                   │         · 群聊：必须 @ 了机器人（mentions 里有机器人的 open_id）
                   ├─ 去重（message_id）、跳过超过 30 分钟的旧消息
                   ├─ 排队：同一聊天内串行，不同聊天之间并行，全局最多 maxConcurrent 个 Claude 进程
                   ├─ 命令（/stop /new /status /help）立即执行，不排队
                   ├─ 回执：在原消息上加 OnIt 表情，完成后换成 DONE，出错或超时换成 ERROR（表情失败时单聊退回发文字）
                   ├─ 引用回复：用 im +messages-mget 取回被引用的原文，一起交给 Claude
                   ├─ 附件：消息和被引用消息里的图片/文件先用 im +messages-resources-download
                   │         下载到 work/inbox/，把路径交给 Claude 用 Read 查看（保留 1 天）
                   ├─ claude -p（prompt 从 stdin 传入；每个 chat_id 各自一个会话，用 --resume 延续）
                   │     --output-format stream-json：边跑边统计步骤；超过 60 秒发进度消息并每分钟原地更新
                   │     /q 前缀：用 quickModel（默认 haiku）开一次性会话，便宜、不带上下文
                   │     --restricted --strict-mcp-config --permission-mode dontAsk
                   │     --tools PowerShell[,Read,Glob,Grep] --allowedTools "PowerShell(lark-cli *)" ...
                   │     --append-system-prompt-file （system-prompt.md 规则 + 人设）
                   └─ 回复：单聊用 im +messages-send，群聊用 im +messages-reply（引用原消息）
                            正文写成文件，再用 --markdown @file 传给 lark-cli；超过 4000 字自动分段
```

关键设计：
- **权限隔离**：Claude 只能执行 lark-cli，其他命令以及用 `;` 拼接的命令都会被拒绝。它不加载 MCP 服务器，也不读个人 settings；只额外开放一项只读权限，读取 lark skills 文档。
- **不经过 cmd.exe**：bridge 直接启动 `lark-cli.exe`（就是 `lark-cli.cmd` 背后的那个程序），避免 `& | ^ %` 这类字符被 cmd 转义坏。
- **命令**：`/stop` 停止本聊天正在跑的任务并取消排队的任务；`/new` 清空本聊天的上下文；`/status` 查看运行状态；`/help` 查看帮助；`/q 问题` 用便宜模型快速回答。
- **文件访问**：`--restricted` 把 Read 限制在工作目录（`work/`）和 lark skills 目录内，Claude 只能看到桥接程序下载的附件，读不到电脑上的其他文件。
- **运维**：日志按天切分，保留 `logRetentionDays` 天；订阅连续失败 `alertAfterFailures` 次后，用机器人私聊告警，恢复后再通知一次。
- **自愈**：订阅进程断开后按退避时间自动重连；`run-hidden.vbs` 守护 bridge，异常退出后 15 秒自动重启；用单实例锁防止重复运行。
- **状态**：`state/state.json` 保存每个聊天的会话 ID 和已处理的消息 ID。

## 文件

| 文件 | 作用 |
|---|---|
| `bridge.js` | 主程序。`node bridge.js --check` 用于自检 |
| `config.json` | 白名单 open_id、超时、回执文字、群聊开关等 |
| `system-prompt.md` | 给 Claude 的工作规则（入库，随 `git pull` 更新） |
| `persona.md` | 默认人设（"小八"） |
| `persona.local.md` | 可选，不入库。存在时代替 `persona.md`，用来给本机机器人换人设；名字用 config.json 的 `botName`。规则和人设每条消息都会重新拼接，改完立即生效 |
| `gemini-login.ps1` | `agent` 为 `gemini` 时用：在隔离的数据目录里登录一次 Gemini CLI |
| `install-autostart.ps1` | 生成 `run-hidden.vbs`，并注册"登录时启动"计划任务（失败时改用"启动"文件夹）。加 `-Uninstall` 卸载 |
| `start.ps1` / `start-background.ps1` / `stop.ps1` | 前台运行（加 `-Check` 只自检）/ 后台启动 / 停止 |

## 在新账户或新设备上部署

**1. 飞书开发者后台（每个应用只需配置一次）**
- 开启机器人能力。事件订阅选择"长连接"方式，并添加 `im.message.receive_v1`。
- 开通权限：
  - 单聊消息：`im:message.p2p_msg:readonly`
  - 群里 @机器人 的消息：`im:message.group_at_msg:readonly`
  - 以机器人身份发消息：`im:message:send_as_bot`
  - 表情回执：`im:message.reactions:write_only`
  - 读取被引用的消息、下载图片和文件：`im:message:readonly`
- 改完后发布新版本。

**2. 在要运行桥接的 Windows 账户下操作（凭据按用户存放，不能跨账户共用）**
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned   # 允许运行 .ps1
# 安装 Node.js
npm i -g @larksuite/cli
lark-cli config init          # 绑定机器人应用（App Secret 存入当前用户的钥匙串）
lark-cli auth login           # 可选：让 Claude 能用 --as user 以你本人身份操作
irm https://claude.ai/install.ps1 | iex ; claude   # 安装 Claude Code 并登录
```
lark skills 文档放在 `%USERPROFILE%\.agents\skills`，可选，能让 Claude 更准确地使用 lark-cli。

**3. 复制程序并配置**
- 复制 `bridge.js`、`config.example.json`、`system-prompt.md`、`*.ps1`、`README.md`（或直接 clone 本仓库）。不要复制 `state/`、`logs/`、`work/`、`run-hidden.vbs`。
- 把 `config.example.json` 复制一份，命名为 `config.json`。白名单 `allowedOpenId` 先保留占位值，下面测试时会从日志里拿到真实的值再填。
- 运行 `.\start.ps1 -Check`，确认 bot 身份是 ready、claude.exe 已找到。
- 运行 `.\start.ps1`，然后给机器人发一条消息。日志里会出现 `忽略非白名单发送者 ou_xxx`，把这个值填进 `config.json` 的 `allowedOpenId`。
- 再次运行 `.\start.ps1` 测试，通过后执行 `.\install-autostart.ps1` 和 `.\start-background.ps1`。

## 换成 Gemini CLI（`agent: "gemini"`）

config.json 里设 `"agent": "gemini"`，桥接就改用 Google 的 Gemini CLI，其余功能（排队、回执、引用、附件、进度、/q、/stop）不变。

```powershell
npm i -g @google/gemini-cli
.\gemini-login.ps1            # 登录一次 Google 账号；也可以改为设置用户环境变量 GEMINI_API_KEY
.\start.ps1 -Check            # 确认 gemini.js 已找到、显示"gemini 登录：已配置"
```

- **调用方式**：`node gemini.js --output-format stream-json --approval-mode default --policy <策略> --skip-trust [--model] [--resume <会话ID>] [--include-directories <skills>]`，prompt 从 stdin 传入。
- **隔离**：`GEMINI_CLI_HOME` 指向 `state/gemini-home`，登录凭据、会话记录都放在这里，不读你自己 `~/.gemini` 里的设置、MCP 服务器和扩展。
- **权限**：每次调用前生成 `state/gemini-home/bridge-policy.toml`，shell 只允许 `lark-cli`，写文件、web_fetch、MCP 一律拒绝；无头模式下其他需要确认的操作也会被拒绝。策略文件加载失败时桥接直接报错，不采用结果。
- **系统提示词**：同样由 `system-prompt.md` + 人设拼成，写进 `state/gemini-home/.gemini/GEMINI.md`，追加在 Gemini 自带的提示词后面。
- **模型**：`geminiModel` 留空用 Gemini 默认（auto）；`/q` 默认用 `flash`。Gemini 不返回费用，日志里记录 token 数。
- **入口路径**：自动查找 `%APPDATA%\npm\node_modules\@google\gemini-cli\bundle\gemini.js`，找不到时在 config.json 里填 `geminiScript`。

## 在同一台电脑上再跑一个机器人

每个实例要用**不同的飞书应用**（同一个应用同时跑两个长连接会互相抢消息）和**不同的目录**（锁文件、会话、日志都在程序目录里）。

1. 在飞书开发者后台新建应用，按上面第 1 步配置。
2. 给 lark-cli 添加第二个 profile：`lark-cli config init --name bot2`（不会覆盖原来的默认应用）。
3. 把仓库再 clone 一份到另一个目录，`config.json` 里设：
   - `larkProfile`：`"bot2"`。桥接自己和 agent 调用的 lark-cli 都会用这个应用（通过环境变量 `LARKSUITE_CLI_PROFILE`）
   - `instanceName`：比如 `"gemini"`。`install-autostart.ps1` 会注册成 `LarkClaudeBridge-gemini`，不会覆盖第一个实例的自启
   - `agent`、`botName`、`allowedOpenId`（新应用下你的 open_id 不一样，要重新取）
4. 照常 `.\start.ps1 -Check` → `.\install-autostart.ps1` → `.\start-background.ps1`。

## 注意事项

- **open_id 按应用区分**：同一个人在不同机器人应用下的 open_id 不一样，换了应用就要重新取白名单 ID。
- **同一个应用不要同时在两台设备上运行**：长连接会把事件随机分给其中一个连接，导致消息被另一台设备"吃掉"。迁移时先停掉旧设备（运行 `stop.ps1`，再加 `-Uninstall` 卸载自启）。
- **路径都是自动查找的**：lark-cli.exe 在 `%APPDATA%\npm\...`；claude.exe 依次查找 PATH、`~\.local\bin`、VS Code 扩展目录。找不到时，在 config.json 里填写 `larkCliExe` / `claudeExe`。
- **Windows PowerShell 5.1** 读取 .ps1 时需要文件带 UTF-8 BOM，否则中文会乱码。
- **如果 Claude 安装失败而且没有提示**：检查 `~\.claude\downloads` 里的安装包大小，有可能被截断了。
- **移植到 macOS / Linux 需要改的地方**：lark-cli 和 claude 的查找路径；`taskkill` 换成 `kill`；`where.exe` 换成 `which`；system-prompt 和 allowedTools 里的 `PowerShell(...)` 换成 `Bash(lark-cli *)`；自启方式换成 launchd 或 systemd（注意 stdin 不能是 /dev/null，否则 consume 会立即退出）。
