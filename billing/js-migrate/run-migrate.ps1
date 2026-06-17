#Requires -Version 5.1
<#
  รัน migrate billing จาก MSSQL → Postgres (Directus)
#>

param(
  [string] $ConfigPath = "..\..\migration.config.local.json",
  [string] $Profile = "billing",
  [string] $MigrateRunMode = "",
  [string] $MigrateMode = "",
  [string] $SourceIndexRange = "",
  [string] $SourceIndexFrom = "",
  [string] $SourceIndexTo = "",
  [string] $SourceCountCap = "",
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
$nodeExtra = Get-MigrateNodeCliArgs -MigrateMode $MigrateMode -MigrateRunMode $MigrateRunMode -SourceIndexRange $SourceIndexRange -SourceIndexFrom $SourceIndexFrom -SourceIndexTo $SourceIndexTo -SourceCountCap $SourceCountCap
& node ./migrate-from-mssql.mjs --config $ConfigPath --profile $Profile @nodeExtra
if ($LASTEXITCODE -ne 0) { throw "migration failed" }

Write-Host "Done"
