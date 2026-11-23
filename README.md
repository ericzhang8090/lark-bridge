# 小八：飞书私人机器人桥接

Codex 独立部署版 `2026.11.24-codex.1` 的配置、验证、打包和回退步骤见 [DEPLOY-CODEX.md](DEPLOY-CODEX.md)。桌面 Codex 与 Lark 机器人分别保存对话，无需记忆同步。

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
| `codex-login.ps1` | `agent` 为 `codex` 时用：在隔离的数据目录里用 ChatGPT 账号登录一次 Codex |
| `lark-mcp.js` | `agent` 为 `codex` 时用：只提供 `lark_cli` 一个工具的本地 MCP 服务器 |
| `gemini-login.ps1` | `agent` 为 `gemini` 时用：在隔离的数据目录里登录一次 Gemini CLI |
| `install-autostart.ps1` | 生成 `run-hidden.vbs`，并在"启动"文件夹放快捷方式，登录时自动后台启动。会顺带删掉旧版注册的计划任务。加 `-Uninstall` 卸载 |
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
> ⚠️ **`lark-cli auth login` 要在普通的 PowerShell 窗口里运行**（Win+R 输入 `powershell`），不要在 Claude 桌面应用、Codex 应用等 Microsoft Store 打包应用的内置终端里运行。新版 lark-cli 把用户登录密钥（DPoP）存在 TPM 里，打包应用里生成的密钥会被 Windows 隔离到该应用内部，桥接（以及其他程序）打不开，以用户身份的调用会报 `dpop_key_missing` / `Keyset does not exist`。在普通窗口生成的密钥则所有程序都能用。

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

> 注意：Google 已经不允许 Gemini CLI 用个人 Google 账号登录（会报 "This client is no longer supported for Gemini Code Assist for individuals"），只能用 `GEMINI_API_KEY`（按 token 计费）。有 Google AI Pro / Ultra 订阅、想用个人账号的，改用下面的 Antigravity CLI。

## 换成 Antigravity CLI（`agent: "agy"`）

用个人 Google 账号（AI Pro / Ultra 订阅）登录，不需要 API Key。

```powershell
irm https://antigravity.google/cli/install.ps1 | iex   # 安装到 %LOCALAPPDATA%\agy\bin\agy.exe
cd <桥接目录>\work ; agy                                # 交互运行一次：浏览器登录 Google 账号、信任 work 目录，然后退出
.\start.ps1 -Check
```

- **调用方式**：`agy.exe --input-format stream-json --output-format stream-json --settings <JSON> --disable-slash-commands [--model] [--conversation <ID>] [--add-dir <skills>]`，prompt 以 `{"event":"user","message":{"content":"..."}}` 从 stdin 传入；每个聊天的 `conversation_id` 用 `--conversation` 延续。
- **权限**：通过 `--settings` 传入只对本次调用生效的设置，不改你的全局 `~/.gemini/antigravity-cli/settings.json`：
  - `agentMode: ""` 关掉 auto 模式（auto 会自动放行它判断为"低风险"的命令，比如 `whoami`）
  - `enableTerminalSandbox: false`：lark-cli 要读 `~/.lark-cli` 和钥匙串，在沙箱里跑不了
  - 只放行 lark-cli 的正则规则；不以 lark-cli 开头的命令、引号外带 `; | & $` 等拼接符号的命令、写文件，都放进 deny 列表
- **为什么用 deny 而不是只靠 allow**：agy 无头模式下，落在"需要确认"的操作会被自动拒绝并**直接结束整轮**（前面的结果也丢了）；明确 deny 的操作只会把错误告诉模型，它会接着把能做的做完。
- **实测的坑**（agy 1.5.14，Windows）：`command(lark-cli)` 这种前缀写法不生效，只能用 `command(regex:...)`；regex 匹配整行，所以必须排除 `; | & $` 等字符，否则 `lark-cli x; whoami` 也会被放行。参数里需要这些字符时，用单引号括起来。
- **系统提示词**：`system-prompt.md` + 人设写成 `work/AGENTS.md`（agy 读取工作目录里的 AGENTS.md）。
- **模型**：`agyModel` 留空用 agy 默认；`/q` 默认用 `gemini-3.8-flash-low`。可选值用 `agy models` 查看。agy 不返回费用，日志里记录 token 数。
- **登录**：凭据存在 Windows 凭据管理器里，自检无法确认是否已登录；过期时机器人会回复提示，重新交互运行一次 `agy` 登录即可。

## 换成 OpenAI Codex（`agent: "codex"`）

用 Codex 桌面应用自带的 `codex.exe`，ChatGPT 账号登录（订阅额度，不需要 API Key）。

```powershell
.\codex-login.ps1        # 用 ChatGPT 账号登录一次；凭据存在 state\codex-home，和 Codex 桌面应用分开
.\start.ps1 -Check       # 确认 codex.exe 已找到、codex 登录显示 Logged in
```

- **调用方式**：`codex exec --json --ignore-user-config --ignore-rules -c sandbox_mode="read-only" -c approval_policy="never" --disable shell_tool --disable unified_exec ... -`，prompt 从 stdin 传入；续接对话用 `codex exec resume <thread_id> -`。
- **权限**：Codex 在 Windows 上的规则文件不会拆开 PowerShell 包装（`powershell -Command '...'`），没法做到"只放行 lark-cli"。所以直接**关掉 shell**（`shell_tool`、`unified_exec`），另外关掉 apps、plugins、浏览器、computer use；只给它一个本地 MCP 工具 `lark_cli`（`lark-mcp.js`），用参数数组直接启动 `lark-cli.exe`，不经过 shell，参数里的 `; | & $` 都只是普通文本。这个工具设为自动批准。
- **隔离**：`CODEX_HOME` 指向 `state/codex-home`，登录凭据和会话记录不会混进你的 Codex 桌面应用；`--ignore-user-config` / `--ignore-rules` 不加载任何个人配置。
- **系统提示词**：写成 `work/AGENTS.md`。附件里的图片用 `-i` 直接附给 Codex；其他文件它读不了。
- **模型**：`codexModel` 留空用默认；`codexEffort` 默认 `medium`，`/q` 快速模式用 `low`。
- **入口路径**：自动查找 `%LOCALAPPDATA%\OpenAI\Codex\bin\<版本>\codex.exe`（桌面应用更新后目录会变，每次取最新的），找不到时在 config.json 里填 `codexExe`。

## 在同一台电脑上再跑一个机器人

每个实例要用**不同的飞书应用**（同一个应用同时跑两个长连接会互相抢消息）和**不同的目录**（锁文件、会话、日志都在程序目录里）。

1. 在飞书开发者后台新建应用，按上面第 1 步配置。
2. 给 lark-cli 添加第二个 profile：`lark-cli config init --name bot2`（不会覆盖原来的默认应用）。
3. 把仓库再 clone 一份到另一个目录，`config.json` 里设：
   - `larkProfile`：`"bot2"`。桥接自己和 agent 调用的 lark-cli 都会用这个应用（通过环境变量 `LARKSUITE_CLI_PROFILE`）
   - `instanceName`：比如 `"gemini"`。`install-autostart.ps1` 会创建启动项 `LarkClaudeBridge-gemini.lnk`，不会覆盖第一个实例的自启
   - `agent`、`botName`、`allowedOpenId`（新应用下你的 open_id 不一样，要重新取）
4. 照常 `.\start.ps1 -Check` → `.\install-autostart.ps1` → `.\start-background.ps1`。

## 让两个机器人在群里讨论

两个实例都在同一台电脑上运行时，可以让它们在群里围绕一个话题轮流发言：

> @小八 /讨论 3轮 远程办公和坐班哪个效率高

也可以用自然说法：**同时 @ 两个机器人**，话里带"讨论 / 辩论 / 商量 / 聊聊"，轮数可以写"2轮"（不写用默认值）：

> @小八 @GiGi 我们只有两个人，怎么搭建采购流程，你们讨论下

识别"@ 了对方"靠对方在飞书里的显示名，填在 `discussionPeerAliases` 里（不区分大小写、包含即可）。嘉宾收到这类消息时不会当普通任务回答，由主持方发起讨论。

- **为什么不靠互相 @**：飞书不一定会把一个机器人发的消息推送给另一个机器人，而且容易死循环。所以两个桥接程序在本机通过共享文件夹交接发言：每场讨论一个 `d-<消息ID>.json`，`next` 字段写着轮到谁；各自每 3 秒扫一次，轮到自己就生成发言、用自己的机器人身份发到群里，再把发言权交给对方。
- **流程**：主持方收到 `/讨论` → 建记录、先发言 → 嘉宾回应 → …… 双方各说完 N 轮后，主持方做总结。默认发在发起消息下的话题里。
- **只聊不动手**：讨论时两个 agent 都不给任何工具（Claude 用空的 `--tools`，agy 把所有命令放进 deny，Gemini 用不放行 shell 的策略），只输出文字，不会动你的数据，也不会把私人信息带进群。
- **群聊背景**：主持方发起前，由桥接程序（不是 agent）读取群里最近 `discussionContextMessages` 条消息（默认 30，0 = 不读），写进讨论记录，两边发言时都能看到。先用机器人身份读，失败再用用户身份。机器人身份需要开通"获取群组中所有消息"权限 `im:message.group_msg`；读不到时照常讨论，并在开场消息里说明。
- **停止**：@ 任意一方发 `/stop`，本群所有进行中的讨论都会结束，正在生成的发言也会被中止。对方超过 `claudeTimeoutMinutes + 2` 分钟没发言（比如没在运行），主持方会在群里说明并结束。
- **配置**（两个实例的 config.json）：

  | 配置 | 主持方（如小八） | 嘉宾（如 GiGi） |
  |---|---|---|
  | `discussionDir` | 同一个共享文件夹 | 同一个共享文件夹 |
  | `discussionPeer` | 对方的 `botName` | 对方的 `botName` |
  | `discussionHost` | `true` | `false` |
  | `discussionPeerAliases` | GiGi 在飞书里的显示名，如 `["gigi"]` | 小八在飞书里的显示名 |

  可选：`discussionDefaultRounds`（默认 3）、`discussionMaxRounds`（默认 10）、`discussionInThread`（默认 true）。`discussionPeer` 必须和对方 config 里的 `botName` 完全一致。
- **前提**：两个机器人都要被拉进这个群，且都开通了群消息相关权限。只需要 @ 主持方；嘉宾不处理 `/讨论` 命令。

## 注意事项

- **open_id 按应用区分**：同一个人在不同机器人应用下的 open_id 不一样，换了应用就要重新取白名单 ID。
- **同一个应用不要同时在两台设备上运行**：长连接会把事件随机分给其中一个连接，导致消息被另一台设备"吃掉"。迁移时先停掉旧设备（运行 `stop.ps1`，再加 `-Uninstall` 卸载自启）。
- **路径都是自动查找的**：lark-cli.exe 在 `%APPDATA%\npm\...`；claude.exe 依次查找 PATH、`~\.local\bin`、VS Code 扩展目录。找不到时，在 config.json 里填写 `larkCliExe` / `claudeExe`。
- **Windows PowerShell 5.1** 读取 .ps1 时需要文件带 UTF-8 BOM，否则中文会乱码。
- **如果 Claude 安装失败而且没有提示**：检查 `~\.claude\downloads` 里的安装包大小，有可能被截断了。
- **移植到 macOS / Linux 需要改的地方**：lark-cli 和 claude 的查找路径；`taskkill` 换成 `kill`；`where.exe` 换成 `which`；system-prompt 和 allowedTools 里的 `PowerShell(...)` 换成 `Bash(lark-cli *)`；自启方式换成 launchd 或 systemd（注意 stdin 不能是 /dev/null，否则 consume 会立即退出）。
