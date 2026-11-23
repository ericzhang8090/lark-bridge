# agent=codex 时用：用 ChatGPT 账号登录一次 Codex。
# 凭据保存在本目录的 state\codex-home 里（和你自己的 Codex 桌面应用 ~/.codex 分开），桥接之后会一直用它。
# 浏览器登录完成后脚本会自动结束。
$ErrorActionPreference = 'Stop'

$codex = $null
$cfgFile = Join-Path $PSScriptRoot 'config.json'
if (Test-Path $cfgFile) {
    try { $codex = [string](Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json).codexExe } catch {}
}
if (-not $codex) {
    $base = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path $base) {
        $codex = Get-ChildItem $base -Directory | ForEach-Object { Join-Path $_.FullName 'codex.exe' } |
            Where-Object { Test-Path $_ } | Sort-Object { (Get-Item $_).LastWriteTime } -Descending | Select-Object -First 1
    }
}
if (-not $codex) { $cmd = Get-Command codex.exe -ErrorAction SilentlyContinue; if ($cmd) { $codex = $cmd.Source } }
if (-not $codex) { throw '找不到 codex.exe，请先安装 Codex 桌面应用，或在 config.json 里设置 codexExe' }

$home2 = Join-Path $PSScriptRoot 'state\codex-home'
New-Item -ItemType Directory -Force $home2 | Out-Null
$env:CODEX_HOME = $home2
Write-Host "Codex 数据目录：$home2"
Write-Host '浏览器会打开 ChatGPT 登录页，登录并授权后回到这里。' -ForegroundColor Yellow
& $codex login
& $codex login status
