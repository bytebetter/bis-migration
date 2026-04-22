#Requires -Version 5.1
<#
  One-click runner for JS migration (Run Code friendly).
  เปิดไฟล์นี้แล้วกด "Run Code" ได้เลย
#>

param(
  [string] $ConfigPath = ".\config.local.json",
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

if (-not $SkipInstall -and -not (Test-Path -LiteralPath ".\node_modules")) {
  Write-Host ">>> Installing dependencies..."
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}

Write-Host ">>> Running migration with config: $ConfigPath"
node .\migrate-from-mssql.mjs --config $ConfigPath
if ($LASTEXITCODE -ne 0) { throw "migration failed" }

Write-Host "Done"
