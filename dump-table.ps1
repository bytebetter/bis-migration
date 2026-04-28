#Requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string] $Table,
  [string] $Profile = "examination",
  [string] $ConfigPath = ".\migration.config.local.json",
  [int] $Limit = 5000,
  [int] $PageSize = 0,
  [switch] $All,
  [string] $Out = ""
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node not found in PATH"
}

$scriptPath = ".\tools\db-export\export-table.mjs"
if (-not (Test-Path -LiteralPath $scriptPath)) {
  throw "Export script not found: $scriptPath"
}

$toolDir = ".\tools\db-export"
if (-not (Test-Path -LiteralPath (Join-Path $toolDir "node_modules"))) {
  Write-Host ">>> Installing export dependencies..."
  npm install --prefix $toolDir
  if ($LASTEXITCODE -ne 0) { throw "npm install failed for $toolDir" }
}

$args = @(
  $scriptPath,
  "--config", $ConfigPath,
  "--profile", $Profile,
  "--table", $Table
)
if (-not $All) {
  $args += @("--limit", "$Limit")
} else {
  $args += @("--all", "true")
}
if ($PageSize -gt 0) {
  $args += @("--page-size", "$PageSize")
}
if ($Out -ne "") {
  $args += @("--out", $Out)
}

node @args
if ($LASTEXITCODE -ne 0) { throw "dump-table failed" }

Write-Host "Done"

