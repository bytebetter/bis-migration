#Requires -Version 5.1
<#
  One-click runner for JS migration (Run Code friendly).
  เปิดไฟล์นี้แล้วกด "Run Code" ได้เลย
#>

param(
  [string] $ConfigPath = "..\..\migration.config.local.json",
  [string] $Profile = "examination",
  [string] $MigrateRunMode = "",
  [string] $MigrateMode = "",
  [string] $SourceKeyRange = "",
  [string] $SourceKeyFrom = "",
  [string] $SourceKeyTo = "",
  [switch] $SkipInstall
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "Config file not found: $ConfigPath"
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm not found in PATH"
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
. (Join-Path $repoRoot "scripts\Ensure-MigrateNodeModules.ps1")
. (Join-Path $repoRoot "scripts\Get-MigrateNodeCliArgs.ps1")
if (-not $SkipInstall) {
  Ensure-MigrateNodeModules -RepoRoot $repoRoot
}

Write-Host ">>> Running migration with config: $ConfigPath (profile: $Profile)"
$nodeExtra = Get-MigrateNodeCliArgs -MigrateMode $MigrateMode -MigrateRunMode $MigrateRunMode -SourceKeyRange $SourceKeyRange -SourceKeyFrom $SourceKeyFrom -SourceKeyTo $SourceKeyTo
& node ./migrate-from-mssql.mjs --config $ConfigPath --profile $Profile @nodeExtra
if ($LASTEXITCODE -ne 0) { throw "migration failed" }

Write-Host "Done"
