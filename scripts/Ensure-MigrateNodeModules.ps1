#Requires -Version 5.1
# Called from run-migrate.ps1 / run-migrate-all.ps1: ensure mssql and pg exist at repo root (single install).

function Ensure-MigrateNodeModules {
  param([Parameter(Mandatory)][string]$RepoRoot)

  $mssqlMod = Join-Path $RepoRoot "node_modules/mssql/package.json"
  $pgMod = Join-Path $RepoRoot "node_modules/pg/package.json"
  if ((Test-Path -LiteralPath $mssqlMod) -and (Test-Path -LiteralPath $pgMod)) {
    return
  }

  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm not found in PATH. Install Node.js (includes npm) and retry."
  }

  Write-Host ">>> Installing shared migrate dependencies at repo root: $RepoRoot"
  Push-Location -LiteralPath $RepoRoot
  try {
    npm install
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed at repo root"
    }
  }
  finally {
    Pop-Location
  }
}
