# Safe test-host harness for DSH Hub plugin.
# Rule: NEVER kill by process name. Start/stop only the PID recorded here.
#
# Usage:
#   pwsh -File scripts/test-host.ps1 -Action start  -Port 3099
#   pwsh -File scripts/test-host.ps1 -Action status
#   pwsh -File scripts/test-host.ps1 -Action stop
#
# The test host runs on plain node.exe (bundled runtime) against the on-disk
# global dsh CLI, so it never shares the "DeepSeek Harness" process name with
# the user's desktop app. (Plain node cannot read inside app.asar.)

param(
  [ValidateSet('start', 'stop', 'status')]
  [string]$Action = 'start',
  [string]$Workdir = (Join-Path $PSScriptRoot '..\_test-host'),
  [string]$DshHome = (Join-Path $PSScriptRoot '..\_test-home'),
  [int]$Port = 3099,
  [string]$Node = 'D:\06_Tools\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe',
  [string]$Bin = 'C:\dev_env\npm\npm_global\node_modules\@deepseek-ai\dsh\lib\bin.js'
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
    if (-not (Test-Path -LiteralPath $Node)) { throw "node.exe not found: $Node" }
    if (-not (Test-Path -LiteralPath $Bin)) { throw "dsh bin.js not found: $Bin" }

    $existing = Get-TestPid
    if ($existing -and (Get-Process -Id $existing -ErrorAction SilentlyContinue)) {
      throw "test host already running: PID $existing"
    }
    if (Test-PortInUse $Port) {
      throw "port $Port is already in use; not starting"
    }

    $env:DSH_HOME = $DshHome
    Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

    $p = Start-Process -FilePath $Node `
      -ArgumentList @($Bin, 'web', '--no-open', '--port', "$Port") `
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

    # Guard: only stop a node.exe process, never a desktop app process.
    if ($proc.Path -and $proc.Path -ne $Node) {
      throw "refusing to kill PID ${id}: path is $($proc.Path), expected $Node"
    }

    Stop-Process -Id $id -Force
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Write-Output "stopped PID $id"
  }
}
