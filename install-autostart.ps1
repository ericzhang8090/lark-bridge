# 注册"登录时自动后台启动"飞书桥接（针对当前 Windows 用户）
#   .\install-autostart.ps1              安装
#   .\install-autostart.ps1 -Uninstall   卸载
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'

$root     = $PSScriptRoot
$taskName = 'LarkClaudeBridge'
$vbs      = Join-Path $root 'run-hidden.vbs'
$startup  = [Environment]::GetFolderPath('Startup')
$lnk      = Join-Path $startup 'LarkClaudeBridge.lnk'
$user     = "$env:USERDOMAIN\$env:USERNAME"

if ($Uninstall) {
    try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop; Write-Host "已删除计划任务 $taskName" } catch {}
    if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "已删除启动项 $lnk" }
    return
}

# 找 node.exe
$node = $null
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }
if (-not $node -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not $node) { throw '找不到 node.exe，请先安装 Node.js' }

# 生成隐藏窗口的守护脚本：bridge 异常退出后 15 秒自动重启；stop.ps1 写入 stop.flag 后退出循环
$vbsContent = @"
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root     = "$root"
stopFlag = root & "\state\stop.flag"
If fso.FileExists(stopFlag) Then fso.DeleteFile stopFlag
Do
  rc = sh.Run("""$node"" """ & root & "\bridge.js""", 0, True)
  If fso.FileExists(stopFlag) Then Exit Do
  If rc = 3 Then Exit Do
  WScript.Sleep 15000
Loop
"@
# VBScript 需要 ANSI/UTF-16 编码，这里用 Unicode (UTF-16 LE) 以支持中文路径
[IO.File]::WriteAllText($vbs, $vbsContent, [Text.Encoding]::Unicode)
Write-Host "已生成 $vbs"

try {
    $action    = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $root
    $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                   -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Write-Host "已注册计划任务 $taskName（$user 登录时启动）"
    if (Test-Path $lnk) { Remove-Item $lnk -Force }
}
catch {
    Write-Warning "注册计划任务失败（$($_.Exception.Message)），改用启动文件夹快捷方式"
    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath = 'wscript.exe'
    $s.Arguments = "`"$vbs`""
    $s.WorkingDirectory = $root
    $s.Save()
    Write-Host "已创建启动项 $lnk"
}
Write-Host "`n现在立即后台启动：.\start-background.ps1"
