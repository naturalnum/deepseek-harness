param(
    [switch]$NoOpen,
    [switch]$ServiceWorker,
    [ValidatePattern('^\d{8}-\d{6}-\d{3}$')][string]$ServiceLogStamp
)
$ErrorActionPreference = 'Stop'
$suite = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node.exe -ErrorAction Stop).Source
$logDir = Join-Path $suite '.data/service-logs'
if ($ServiceWorker) {
    if (-not $ServiceLogStamp) { throw 'A service log timestamp is required.' }
    $stdout = Join-Path $logDir ($ServiceLogStamp + '.stdout.log')
    $stderr = Join-Path $logDir ($ServiceLogStamp + '.stderr.log')
    $service = Start-Process -FilePath $node -ArgumentList 'scripts/start-all.mjs' -WorkingDirectory $suite -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $null = $service.Handle
    $service.WaitForExit()
    exit $service.ExitCode
}
$mutex = New-Object System.Threading.Mutex($false, 'Local\EPRIResearchManualStartup')
$locked = $false
$check = "import {suitePaths} from './src/server/paths.mjs'; import {researchRunning,harnessRunning} from './scripts/service-status.mjs'; try {const ready=await Promise.all([researchRunning(suitePaths().directory),harnessRunning()]); process.exitCode=ready.every(Boolean)?0:1;} catch {process.exitCode=2;}"
Push-Location $suite
try {
    try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Startup is already in progress. Please wait for that window to finish.' }
    & $node --input-type=module -e $check
    if ($LASTEXITCODE -eq 2) { throw 'Service check failed: port conflict or wrong data directory. No new service was started.' }
    if ($LASTEXITCODE -ne 0) {
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        # WMI starts the worker outside a temporary terminal's Windows Job.
        # Preserve the caller's environment, including configured data paths.
        $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
            ShowWindow = [uint16]0
            EnvironmentVariables = [string[]](Get-ChildItem Env: | ForEach-Object { $_.Name + '=' + $_.Value })
        }
        $command = '"' + (Join-Path $PSHOME 'powershell.exe') + '" -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -ServiceWorker -ServiceLogStamp "' + $stamp + '"'
        $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command; CurrentDirectory = $suite; ProcessStartupInformation = $startup }
        if ($created.ReturnValue -ne 0) { throw "Cannot start the independent service worker (code $($created.ReturnValue))." }
        $service = Get-Process -Id $created.ProcessId -ErrorAction Stop
        $null = $service.Handle
        Write-Host 'Starting services in the background. Waiting for both pages...'
        $deadline = (Get-Date).AddMinutes(3)
        do {
            & $node --input-type=module -e $check
            if ($LASTEXITCODE -eq 0) { break }
            $service.Refresh()
            if ($LASTEXITCODE -eq 2 -or $service.HasExited) { throw "Startup failed. Check the private service logs in $logDir" }
            if ((Get-Date) -ge $deadline) { throw "Startup is taking longer than expected. Check $logDir before trying again." }
            Start-Sleep -Seconds 2
        } while ($true)
    }
    Write-Host 'Ready: http://127.0.0.1:43128/ (Harness)'
    Write-Host 'Ready: http://127.0.0.1:43128/research/ (embedded right-sidebar workbench)'
    Write-Host 'The services run independently of this window. This is manual startup, not startup at login.'
    if (-not $NoOpen) {
        $launch = $null
        $latestLog = Get-ChildItem -LiteralPath $logDir -Filter '*.stdout.log' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
        if ($latestLog) {
            $stream = [IO.File]::Open($latestLog.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
            $reader = New-Object IO.StreamReader($stream)
            try { $logText = $reader.ReadToEnd() } finally { $reader.Dispose() }
            $match = [regex]::Match($logText, '(?m)^dsh web:\s+(http://127\.0\.0\.1:43128/\S*)')
            if ($match.Success) { $launch = $match.Groups[1].Value }
        }
        if ($launch) {
            # Pass the local authentication link directly to the browser; never print it.
            Start-Process -FilePath $launch
        } else {
            Start-Process -FilePath 'http://127.0.0.1:43128/'
            Write-Host 'If authentication is requested, use the private launch link from the running service console.'
        }
    }
} finally {
    Pop-Location
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
