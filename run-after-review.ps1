#Requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string] $ReviewedJsonPath,
  [ValidateSet("patient_info","examination","appointment")]
  [string] $Profile = "examination"
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path -LiteralPath $ReviewedJsonPath)) {
  throw "Reviewed JSON not found: $ReviewedJsonPath"
}

Write-Host ">>> Reviewed file: $ReviewedJsonPath"
Write-Host ">>> Starting migration profile: $Profile"

switch ($Profile) {
  "patient_info" {
    & ".\patient-info\js-migrate\run-migrate.ps1"
  }
  "examination" {
    & ".\examination\js-migrate\run-migrate.ps1"
  }
  "appointment" {
    & ".\appointment\js-migrate\run-migrate.ps1"
  }
}

if ($LASTEXITCODE -ne 0) { throw "run-after-review failed" }
Write-Host "Done"

