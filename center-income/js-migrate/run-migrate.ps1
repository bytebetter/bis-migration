#Requires -Version 5.1
<#
  รัน migration center_income (MSSQL dbo.income + dbo.income2 -> Postgres / Directus public.center_income)

  เดินครบทุกแถวทุกรอบ เทียบด้วย old_db_id ("income:ID" / "income2:ID") — รันซ้ำได้ ไม่เกิดแถวซ้ำ
  แถว income2 ที่มีคู่ก๊อปใน income (Income_ID + 364480) ถูกตัดทิ้ง (เก็บของ income)
  ดีฟอลต์ (resume/insert-only) = insert เฉพาะคีย์ใหม่ + เติม patient_info ที่ยังว่าง ไม่ทับข้อมูลที่แก้ในระบบใหม่
  -MigrateRunMode overwrite = เขียนทับแถวเดิมให้ตรงต้นทางด้วย (ไม่แตะ status)
  ต้องรันหลัง patient_info (relation resolve จาก PID)
#>

param(
  [string] $ConfigPath = "..\..\migration.config.local.json",
  [string] $Profile = "center_income",
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
