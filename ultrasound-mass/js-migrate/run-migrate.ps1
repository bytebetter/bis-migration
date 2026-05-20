#Requires -Version 5.1
<#
  One-click runner for JS migration (Run Code friendly).
  เปิดไฟล์นี้แล้วกด "Run Code" ได้เลย
#>

param(
  [string] $ConfigPath = "..\..\migration.config.local.json",
  [string] $Profile = "ultrasound_mass",
  [switch] $SkipInstall
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

function Enable-ConsoleVtProcessing {
  if (-not ($IsWindows -or $env:OS -like "Windows*")) {
    return
  }
  if (-not ([System.Management.Automation.PSTypeName]'Win32.NativeMethods').Type) {
    $signature = @"
using System;
using System.Runtime.InteropServices;
public static class NativeMethods {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr GetStdHandle(int nStdHandle);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
}
"@
    Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue | Out-Null
  }
  if (-not ([System.Management.Automation.PSTypeName]'Win32.NativeMethods').Type) {
    return
  }
  $enableVt = 0x0004
  foreach ($handleId in -11, -12) {
    $handle = [Win32.NativeMethods]::GetStdHandle($handleId)
    if ($handle -eq [IntPtr]::Zero) {
      continue
    }
    $mode = [uint32]0
    if (-not [Win32.NativeMethods]::GetConsoleMode($handle, [ref]$mode)) {
      continue
    }
    [void][Win32.NativeMethods]::SetConsoleMode($handle, ($mode -bor $enableVt))
  }
}

Enable-ConsoleVtProcessing

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "Config file not found: $ConfigPath"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm not found in PATH"
}

if (-not $SkipInstall -and -not (Test-Path -LiteralPath "./node_modules")) {
  Write-Host ">>> Installing dependencies..."
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}

Write-Host ">>> Running migration with config: $ConfigPath (profile: $Profile)"
node ./migrate-from-mssql.mjs --config $ConfigPath --profile $Profile
if ($LASTEXITCODE -ne 0) { throw "migration failed" }

Write-Host "Done"
