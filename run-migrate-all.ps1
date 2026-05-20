#Requires -Version 5.1
<#
  รัน migrate ทุกตารางตามลำดับ FK / ความสัมพันธ์ข้อมูล

  ใช้งาน:
    .\run-migrate-all.ps1
    .\run-migrate-all.ps1 -SkipInstall
    .\run-migrate-all.ps1 -StartFrom 3
    .\run-migrate-all.ps1 -LogPath ".\logs\my-run.log"
#>

param(
  [string] $ConfigPath = ".\migration.config.local.json",
  [int] $StartFrom = 1,
  [switch] $SkipInstall,
  [string] $LogPath = ""
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not [System.IO.Path]::IsPathRooted($ConfigPath)) {
  $ConfigPath = Join-Path $PSScriptRoot $ConfigPath
}
$ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "Config file not found: $ConfigPath"
}

$logDir = Join-Path $PSScriptRoot "logs"
if (-not $LogPath) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $LogPath = Join-Path $logDir "run-migrate-all-$stamp.log"
}
$statusPath = Join-Path $logDir "run-migrate-all.current.txt"

if (-not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Write-MigrateLog {
  param(
    [string] $Message,
    [ValidateSet("INFO", "START", "OK", "FAIL", "SKIP")]
    [string] $Level = "INFO"
  )
  $line = "{0:yyyy-MM-dd HH:mm:ss} [{1}] {2}" -f (Get-Date), $Level, $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  switch ($Level) {
    "FAIL" { Write-Host $line -ForegroundColor Red }
    "OK"   { Write-Host $line -ForegroundColor Green }
    "START" { Write-Host $line -ForegroundColor Cyan }
    default { Write-Host $line }
  }
}

function Set-MigrateStatus {
  param([string] $Text)
  Set-Content -LiteralPath $statusPath -Value $Text -Encoding UTF8
}

$steps = @(
  @{ N = 1;  Table = "patient_info";        Script = ".\patient-info\js-migrate\run-migrate.ps1" },
  @{ N = 2;  Table = "appointment";         Script = ".\appointment\js-migrate\run-migrate.ps1" },
  @{ N = 3;  Table = "examination";         Script = ".\examination\js-migrate\run-migrate.ps1" },
  @{ N = 4;  Table = "examination_general"; Script = ".\examination-general\js-migrate\run-migrate.ps1" },
  @{ N = 5;  Table = "pacs_sync_info";      Script = ".\pacs-sync-info\js-migrate\run-migrate.ps1" },
  @{ N = 6;  Table = "procedure";           Script = ".\procedure\js-migrate\run-migrate.ps1" },
  @{ N = 7;  Table = "ultrasound";          Script = ".\ultrasound\js-migrate\run-migrate.ps1" },
  @{ N = 8;  Table = "mammogram";           Script = ".\mam\js-migrate\run-migrate.ps1" },
  @{ N = 9;  Table = "mammogram_cal";       Script = ".\mam-cal\js-migrate\run-migrate.ps1" },
  @{ N = 10; Table = "mammogram_mass";      Script = ".\mam-mass\js-migrate\run-migrate.ps1" },
  @{ N = 11; Table = "ultrasound_cyst";     Script = ".\ultrasound-cyst\js-migrate\run-migrate.ps1" },
  @{ N = 12; Table = "ultrasound_mass";     Script = ".\ultrasound-mass\js-migrate\run-migrate.ps1" }
)

$repoRoot = $PSScriptRoot
$total = $steps.Count
$started = Get-Date

Write-MigrateLog "=== BIS migrate all started ($total tables) ==="
Write-MigrateLog "Config: $ConfigPath"
Write-MigrateLog "Log file: $LogPath"
Write-MigrateLog "Status file: $statusPath"
if ($StartFrom -gt 1) { Write-MigrateLog "StartFrom step: $StartFrom" }

Set-MigrateStatus ('RUNNING ; waiting to start ; 0/{0}' -f $total)

foreach ($step in $steps) {
  if ($step.N -lt $StartFrom) {
    Write-MigrateLog "[$($step.N)/$total] $($step.Table) (skipped, StartFrom=$StartFrom)" -Level SKIP
    continue
  }

  $label = "[$($step.N)/$total] $($step.Table)"
  $scriptPath = Join-Path $repoRoot ($step.Script -replace '^\.\\', '')
  if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Migration script not found: $scriptPath"
  }

  Set-MigrateStatus ('RUNNING ; {0} ; {1}/{2}' -f $label, $step.N, $total)
  Write-MigrateLog ('{0} - starting {1}' -f $label, $scriptPath) -Level START

  $invokeArgs = @{ ConfigPath = $ConfigPath }
  if ($SkipInstall) { $invokeArgs.SkipInstall = $true }
  elseif ($step.N -gt 1) { $invokeArgs.SkipInstall = $true }

  $stepStarted = Get-Date
  try {
    # สคริปต์ลูกใช้ Set-Location เปลี่ยน cwd ทั้ง session — ต้องกลับ root ก่อนเรียกแต่ละตาราง
    Set-Location -LiteralPath $repoRoot
    & $scriptPath @invokeArgs
    if ($LASTEXITCODE -ne 0) {
      throw "exit code $LASTEXITCODE"
    }
    $stepElapsed = (Get-Date) - $stepStarted
    Write-MigrateLog ('{0} - done in {1}' -f $label, $stepElapsed.ToString('hh\:mm\:ss')) -Level OK
    Set-MigrateStatus ('DONE step ; {0} ; {1}/{2}' -f $label, $step.N, $total)
  }
  catch {
    Write-MigrateLog ('{0} - FAILED: {1}' -f $label, $_) -Level FAIL
    Set-MigrateStatus ('FAILED ; {0} ; {1}/{2}' -f $label, $step.N, $total)
    throw "Migration failed at step $($step.N): $($step.Table). See log: $LogPath"
  }
}

$elapsed = (Get-Date) - $started
Write-MigrateLog "=== All migrations completed in $($elapsed.ToString('hh\:mm\:ss')) ===" -Level OK
Set-MigrateStatus ('ALL DONE ; {0}/{0} tables ; {1}' -f $total, $elapsed.ToString('hh\:mm\:ss'))
