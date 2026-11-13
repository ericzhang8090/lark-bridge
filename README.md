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
                   ├─ 去重（message_id）、跳过超过 30 分钟的旧消息、逐条排队
                   ├─ 回执：单聊发"处理中"文字；群聊在原消息上加一个 OnIt 表情
                   ├─ claude -p（prompt 从 stdin 传入；每个 chat_id 各自一个会话，用 --resume 延续）
                   │     --restricted --strict-mcp-config --permission-mode dontAsk
                   │     --tools PowerShell[,Read,Glob,Grep] --allowedTools "PowerShell(lark-cli *)" ...
                   │     --append-system-prompt-file system-prompt.md  （规则 + 人设）
                   └─ 回复：单聊用 im +messages-send，群聊用 im +messages-reply（引用原消息）
                            正文写成文件，再用 --markdown @file 传给 lark-cli；超过 4000 字自动分段
```

关键设计：
- **权限隔离**：Claude 只能执行 lark-cli，其他命令以及用 `;` 拼接的命令都会被拒绝。它不加载 MCP 服务器，也不读个人 settings；只额外开放一项只读权限，读取 lark skills 文档。
- **不经过 cmd.exe**：bridge 直接启动 `lark-cli.exe`（就是 `lark-cli.cmd` 背后的那个程序），避免 `& | ^ %` 这类字符被 cmd 转义坏。
- **自愈**：订阅进程断开后按退避时间自动重连；`run-hidden.vbs` 守护 bridge，异常退出后 15 秒自动重启；用单实例锁防止重复运行。
- **状态**：`state/state.json` 保存每个聊天的会话 ID 和已处理的消息 ID。

## 文件

| 文件 | 作用 |
|---|---|
| `bridge.js` | 主程序。`node bridge.js --check` 用于自检 |
| `config.json` | 白名单 open_id、超时、回执文字、群聊开关等 |
| `system-prompt.md` | 给 Claude 的规则和"小八"人设，每条消息都会重新读取，改完立即生效 |
| `install-autostart.ps1` | 生成 `run-hidden.vbs`，并注册"登录时启动"计划任务（失败时改用"启动"文件夹）。加 `-Uninstall` 卸载 |
| `start.ps1` / `start-background.ps1` / `stop.ps1` | 前台运行（加 `-Check` 只自检）/ 后台启动 / 停止 |

## 在新账户或新设备上部署

**1. 飞书开发者后台（每个应用只需配置一次）**
- 开启机器人能力。事件订阅选择"长连接"方式，并添加 `im.message.receive_v1`。
- 开通权限：
  - 单聊消息：`im:message.p2p_msg:readonly`
  - 群里 @机器人 的消息：`im:message.group_at_msg:readonly`
  - 以机器人身份发消息：`im:message:send_as_bot`
  - 表情回执（可选）：`im:message.reactions:write_only`
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

## 注意事项

- **open_id 按应用区分**：同一个人在不同机器人应用下的 open_id 不一样，换了应用就要重新取白名单 ID。
- **同一个应用不要同时在两台设备上运行**：长连接会把事件随机分给其中一个连接，导致消息被另一台设备"吃掉"。迁移时先停掉旧设备（运行 `stop.ps1`，再加 `-Uninstall` 卸载自启）。
- **路径都是自动查找的**：lark-cli.exe 在 `%APPDATA%\npm\...`；claude.exe 依次查找 PATH、`~\.local\bin`、VS Code 扩展目录。找不到时，在 config.json 里填写 `larkCliExe` / `claudeExe`。
- **Windows PowerShell 5.1** 读取 .ps1 时需要文件带 UTF-8 BOM，否则中文会乱码。
- **如果 Claude 安装失败而且没有提示**：检查 `~\.claude\downloads` 里的安装包大小，有可能被截断了。
- **移植到 macOS / Linux 需要改的地方**：lark-cli 和 claude 的查找路径；`taskkill` 换成 `kill`；`where.exe` 换成 `which`；system-prompt 和 allowedTools 里的 `PowerShell(...)` 换成 `Bash(lark-cli *)`；自启方式换成 launchd 或 systemd（注意 stdin 不能是 /dev/null，否则 consume 会立即退出）。
