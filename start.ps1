# 前台运行（调试用，Ctrl+C 退出）。加 -Check 只做自检。
param([switch]$Check)
$node = $null
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source } elseif (Test-Path 'C:\Program Files\nodejs\node.exe') { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not $node) { throw '找不到 node.exe' }
$script = Join-Path $PSScriptRoot 'bridge.js'
if ($Check) { & $node $script --check } else { & $node $script }
