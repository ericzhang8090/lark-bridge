# agent=gemini 时用：以交互模式打开 Gemini CLI，登录一次 Google 账号。
# 凭据保存在本目录的 state\gemini-home 里（和你自己用的 ~/.gemini 分开），桥接之后会一直用它。
# 登录完成、看到对话界面后，输入 /quit 退出即可。
# 也可以不登录，改为设置用户环境变量 GEMINI_API_KEY（在 https://aistudio.google.com/apikey 申请），然后重启桥接。
$ErrorActionPreference = 'Stop'

$node = $null
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source } elseif (Test-Path 'C:\Program Files\nodejs\node.exe') { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not $node) { throw '找不到 node.exe' }

$script = $null
$cfgFile = Join-Path $PSScriptRoot 'config.json'
if (Test-Path $cfgFile) {
    try { $script = [string](Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json).geminiScript } catch {}
}
if (-not $script) { $script = Join-Path $env:APPDATA 'npm\node_modules\@google\gemini-cli\bundle\gemini.js' }
if (-not (Test-Path $script)) { throw "找不到 Gemini CLI（$script），请先运行 npm install -g @google/gemini-cli" }

$home2 = Join-Path $PSScriptRoot 'state\gemini-home'
New-Item -ItemType Directory -Force $home2 | Out-Null
$env:GEMINI_CLI_HOME = $home2
Write-Host "Gemini 数据目录：$home2"
Write-Host '在弹出的界面里选择 "Sign in with Google"，浏览器登录完成后输入 /quit 退出。' -ForegroundColor Yellow
& $node $script
