# Safe test-host harness for DSH Hub plugin.
# Rule: NEVER kill by process name. Start/stop only the PID recorded here.
#
# Usage:
#   pwsh -File scripts/test-host.ps1 -Action start  -Port 3099
#   pwsh -File scripts/test-host.ps1 -Action status
#   pwsh -File scripts/test-host.ps1 -Action stop
#
# Why Electron.exe: the DSH CLI lives inside app.asar, which plain node.exe
# cannot read. The test host therefore runs as "DeepSeek Harness.exe" too, but
# this script ONLY ever stops the PID it recorded, and refuses to stop any
# process whose path is not the expected executable. Never kill by name.

param(
  [ValidateSet('start', 'stop', 'status')]
  [string]$Action = 'start',
  [string]$Workdir = (Join-Path $PSScriptRoot '..\_test-host'),
  [string]$DshHome = (Join-Path $PSScriptRoot '..\_test-home'),
  [int]$Port = 3099,
  [string]$Exe = 'D:\06_Tools\DeepSeek Harness\DeepSeek Harness.exe',
  [string]$Bin = 'D:\06_Tools\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js',
  [string]$Asar = 'D:\06_Tools\DeepSeek Harness\resources\app.asar'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Workdir, $DshHome | Out-Null

$pidFile = Join-Path $Workdir 'host.pid'
$outLog = Join-Path $Workdir 'host.log'
$errLog = Join-Path $Workdir 'host.err'

function Get-TestPid {
  if (-not (Test-Path $pidFile)) { return $null }
  $raw = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  if (-not $raw) { return $null }
  return [int]$raw
}

function Test-PortInUse([int]$p) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $client.Connect('127.0.0.1', $p)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

switch ($Action) {
  'start' {
    if (-not (Test-Path -LiteralPath $Exe)) { throw "DeepSeek Harness.exe not found: $Exe" }
    if (-not (Test-Path -LiteralPath $Asar)) { throw "app.asar not found: $Asar" }

    $existing = Get-TestPid
    if ($existing -and (Get-Process -Id $existing -ErrorAction SilentlyContinue)) {
      throw "test host already running: PID $existing"
    }
    if (Test-PortInUse $Port) {
      throw "port $Port is already in use; not starting"
    }

    $env:DSH_HOME = $DshHome
    $env:ELECTRON_RUN_AS_NODE = '1'

    $arguments = @('--expose-internals', ('"' + $Bin + '"'), '--profile', 'web', 'web', '--no-open', '--port', "$Port")
    $p = Start-Process -FilePath $Exe `
      -ArgumentList $arguments `
      -WorkingDirectory $Workdir `
      -RedirectStandardOutput $outLog `
      -RedirectStandardError $errLog `
      -PassThru -WindowStyle Hidden

    Set-Content -LiteralPath $pidFile -Value $p.Id -Encoding ASCII
    Write-Output "started test host PID=$($p.Id) port=$Port home=$DshHome"
    Write-Output "log: $outLog"
  }

  'status' {
    $id = Get-TestPid
    if (-not $id) {
      Write-Output 'no pid file'
      if (Test-PortInUse $Port) { Write-Output "port $Port is in use (owner unknown)" }
      break
    }
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Output "running PID $id started $($proc.StartTime) path=$($proc.Path)"
    } else {
      Write-Output "stale pid file ($id); process not running"
    }
    if (Test-PortInUse $Port) { Write-Output "port $Port listening" } else { Write-Output "port $Port closed" }
  }

  'stop' {
    $id = Get-TestPid
    if (-not $id) {
      Write-Output 'no pid file; nothing to stop (will not kill by name/port blindly)'
      break
    }

    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $proc) {
      Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
      Write-Output "PID $id already gone; removed stale pid file"
      break
    }

    # Guard: only stop the expected executable, never another app instance.
    if ($proc.Path -and $proc.Path -ne $Exe) {
      throw "refusing to kill PID ${id}: path is $($proc.Path), expected $Exe"
    }

    Stop-Process -Id $id -Force
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Write-Output "stopped PID $id"
  }
}

