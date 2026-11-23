# 立即在后台（无窗口）启动桥接，需要先运行 install-autostart.ps1 生成 run-hidden.vbs
$vbs = Join-Path $PSScriptRoot 'run-hidden.vbs'
if (-not (Test-Path $vbs)) { throw '缺少 run-hidden.vbs，请先运行 .\install-autostart.ps1' }
Start-Process wscript.exe -ArgumentList "`"$vbs`"" -WindowStyle Hidden
Write-Host "已后台启动，日志在 $(Join-Path $PSScriptRoot 'logs')"
