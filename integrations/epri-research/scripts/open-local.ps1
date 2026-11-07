$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$suite = Split-Path $PSScriptRoot -Parent
$logDir = Join-Path $suite '.data/service-logs'
$mutex = New-Object Threading.Mutex($false, 'Local\EPRIResearchLauncherWindow')
$locked = $false
$form = $null
$timer = $null
$result = 0
try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { exit 0 }
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdout = Join-Path $logDir ($stamp + '.launcher-out.log')
    $stderr = Join-Path $logDir ($stamp + '.launcher-error.log')

    $form = New-Object Windows.Forms.Form
    $form.Text = 'DeepScientist 科研平台'
    $form.ClientSize = New-Object Drawing.Size(460, 218)
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.BackColor = [Drawing.Color]::White
    $form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
    $form.AutoScaleMode = 'Dpi'

    $heading = New-Object Windows.Forms.Label
    $heading.Text = '正在打开科研平台'
    $heading.Font = New-Object Drawing.Font('Microsoft YaHei UI', 16, [Drawing.FontStyle]::Bold)
    $heading.SetBounds(28, 25, 404, 36)
    $heading.ForeColor = [Drawing.Color]::FromArgb(15, 17, 21)
    $form.Controls.Add($heading)

    $status = New-Object Windows.Forms.Label
    $status.Text = '正在检查本机服务…'
    $status.SetBounds(29, 79, 402, 30)
    $status.ForeColor = [Drawing.Color]::FromArgb(97, 102, 107)
    $form.Controls.Add($status)

    $progress = New-Object Windows.Forms.ProgressBar
    $progress.SetBounds(29, 121, 402, 6)
    $progress.Style = 'Marquee'
    $progress.MarqueeAnimationSpeed = 30
    $form.Controls.Add($progress)

    $hint = New-Object Windows.Forms.Label
    $hint.Text = "准备好后将自动打开网页。`r`n关闭此窗口，启动仍会在后台继续。"
    $hint.Font = New-Object Drawing.Font('Microsoft YaHei UI', 9)
    $hint.ForeColor = [Drawing.Color]::FromArgb(129, 133, 140)
    $hint.SetBounds(29, 148, 402, 46)
    $form.Controls.Add($hint)

    $worker = Join-Path $PSScriptRoot 'start-local.ps1'
    $arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $worker + '"'
    $serviceLauncher = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WorkingDirectory $suite -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    # Keep the process handle so Windows PowerShell retains the child's exit code.
    $null = $serviceLauncher.Handle
    $started = Get-Date
    $timer = New-Object Windows.Forms.Timer
    $timer.Interval = 250
    $timer.Add_Tick({
        $serviceLauncher.Refresh()
        if ($serviceLauncher.HasExited) {
            $timer.Stop()
            $form.Close()
        } else {
            $elapsed = [int]((Get-Date) - $started).TotalSeconds
            if ($elapsed -ge 5) { $status.Text = "正在准备服务，已等待 $elapsed 秒…" }
        }
    })
    $timer.Start()
    [void]$form.ShowDialog()
    # Closing the progress window leaves the startup worker running independently.
    $timer.Stop()
    $serviceLauncher.WaitForExit()
    $result = $serviceLauncher.ExitCode
    Add-Content -LiteralPath (Join-Path $logDir ($stamp + '.launcher-status.log')) -Value "Startup worker exit code: $result"
    if ($result -ne 0) {
        [void][Windows.Forms.MessageBox]::Show("暂时未能打开科研平台。`r`n请稍后重试；如果问题持续，请保留以下目录中的启动日志：`r`n$logDir", '启动未完成', 'OK', 'Warning')
    }
} catch {
    $result = 1
    if ($stamp) { Add-Content -LiteralPath (Join-Path $logDir ($stamp + '.launcher-status.log')) -Value ('Launcher error: ' + $_.Exception.GetType().Name) -ErrorAction SilentlyContinue }
    [void][Windows.Forms.MessageBox]::Show("启动器未能完成操作。请检查软件目录和 Node.js 是否可用。`r`n日志目录：$logDir", '启动未完成', 'OK', 'Warning')
} finally {
    if ($timer) { $timer.Dispose() }
    if ($form) { $form.Dispose() }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
exit $result
