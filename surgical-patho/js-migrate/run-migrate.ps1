#Requires -Version 5.1
<#
  รัน migration surgical_patho (MSSQL dbo.SURGICAL_PATHO -> Postgres / Directus public.surgical_patho)

  เดินครบทุกแถวทุกรอบ เทียบด้วย (old_pid, old_surgical_id) — รันซ้ำได้ ไม่เกิดแถวซ้ำ
  ดีฟอลต์ (resume/insert-only) = insert เฉพาะคีย์ใหม่ + เติม relation ที่ยังว่าง ไม่ทับข้อมูลที่แก้ในระบบใหม่
  -MigrateRunMode overwrite = เขียนทับแถวเดิมให้ตรงต้นทางด้วย
  ต้องรันหลัง patient_info / examination / procedure (relation resolve จากตารางเหล่านั้น)
#>

param(
  [string] $ConfigPath = "..\..\migration.config.local.json",
  [string] $Profile = "surgical_patho",
  [string] $MigrateRunMode = "",
  [string] $MigrateMode = "",
  [string] $SourceIndexRange = "",
  [string] $SourceIndexFrom = "",
  [string] $SourceIndexTo = "",
  [string] $SourceCountCap = "",
  [string] $SourceKeyRange = "",
  [string] $SourceIds = "",
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

Write-MigrateDetail ">>> Running migration with config: $ConfigPath (profile: $Profile)"
$nodeExtra = Get-MigrateNodeCliArgs -MigrateMode $MigrateMode -MigrateRunMode $MigrateRunMode -SourceIndexRange $SourceIndexRange -SourceIndexFrom $SourceIndexFrom -SourceIndexTo $SourceIndexTo -SourceCountCap $SourceCountCap -SourceKeyRange $SourceKeyRange -SourceIds $SourceIds
& node ./migrate-from-mssql.mjs --config $ConfigPath --profile $Profile @nodeExtra
if ($LASTEXITCODE -ne 0) { throw "migration failed" }

Write-MigrateDetail "Done"
