# 停止后台桥接（不会被守护脚本自动拉起；下次登录时会再次自动启动）
$root = $PSScriptRoot
$stateDir = Join-Path $root 'state'
New-Item -ItemType Directory -Force $stateDir | Out-Null
Set-Content -Path (Join-Path $stateDir 'stop.flag') -Value 'stop' -Encoding ascii
$lock = Join-Path $stateDir 'bridge.lock'
if (Test-Path $lock) {
    $bridgePid = [int](Get-Content $lock -Raw)
    if (Get-Process -Id $bridgePid -ErrorAction SilentlyContinue) {
        taskkill /PID $bridgePid /T /F | Out-Null
        Write-Host "已停止桥接 (pid $bridgePid)"
    } else {
        Write-Host '桥接未在运行'
    }
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
} else {
    Write-Host '桥接未在运行'
}
