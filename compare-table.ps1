#Requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string] $Table,
  [string] $PgTable = "",
  [string] $Profile = "patient_info",
  [string] $ConfigPath = ".\migration.config.local.json",
  [int] $Length = 1000,
  [string] $OrderBy = "",
  [string] $OrderByPg = "",
  [string] $KeyColumn = "",
  [string] $MssqlKeyColumn = "",
  [string] $PgKeyColumn = "",
  [string] $KeyStart = "",
  [string] $KeyEnd = "",
  [int] $MaxDiffRows = 200,
  [switch] $NoSample
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node not found in PATH"
}

$toolDir = ".\tools\db-compare"
$scriptPath = Join-Path $toolDir "compare-table.mjs"
if (-not (Test-Path -LiteralPath $scriptPath)) {
  throw "Compare script not found: $scriptPath"
}

if (-not (Test-Path -LiteralPath (Join-Path $toolDir "node_modules"))) {
  Write-Host ">>> Installing compare dependencies..."
  npm install --prefix $toolDir
  if ($LASTEXITCODE -ne 0) { throw "npm install failed for $toolDir" }
}

$args = @(
  $scriptPath,
  "--config", $ConfigPath,
  "--profile", $Profile,
  "--table", $Table,
  "--length", "$Length"
)

if ($PgTable -ne "") {
  $args += @("--pg-table", $PgTable)
}

if ($OrderBy -ne "") {
  $args += @("--order-by", $OrderBy)
}
if ($OrderByPg -ne "") {
  $args += @("--order-by-pg", $OrderByPg)
}

if ($KeyColumn -ne "") {
  $args += @("--key-column", $KeyColumn)
}
if ($MssqlKeyColumn -ne "") {
  $args += @("--mssql-key-column", $MssqlKeyColumn)
}
if ($PgKeyColumn -ne "") {
  $args += @("--pg-key-column", $PgKeyColumn)
}

$hasRangeStart = $KeyStart -ne ""
$hasRangeEnd = $KeyEnd -ne ""
if ($hasRangeStart -or $hasRangeEnd) {
  if (-not ($hasRangeStart -and $hasRangeEnd)) {
    throw "Please provide both -KeyStart and -KeyEnd together"
  }
  $args += @("--key-start", $KeyStart, "--key-end", $KeyEnd)
}

$args += @("--max-diff-rows", "$MaxDiffRows")

if ($NoSample) {
  $args += @("--include-sample", "false")
}

node @args
if ($LASTEXITCODE -ne 0) { throw "compare-table failed" }

Write-Host "Done"
