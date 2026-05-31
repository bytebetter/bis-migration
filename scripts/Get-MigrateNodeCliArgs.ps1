#Requires -Version 5.1
<#
  สร้างอาร์กิวเมนต์ CLI ร่วมสำหรับ node migrate-from-mssql.mjs
#>

function Get-MigrateNodeCliArgs {
  param(
    [string] $MigrateMode = "",
    [string] $MigrateRunMode = "",
    [string] $SourceIndexRange = "",
    [string] $SourceIndexFrom = "",
    [string] $SourceIndexTo = "",
    [string] $SourceKeyRange = "",
    [string] $SourceKeyFrom = "",
    [string] $SourceKeyTo = ""
  )

  $extra = @()
  $runMode = if ($MigrateRunMode) { $MigrateRunMode.Trim().ToLowerInvariant() } else { "" }

  switch ($runMode) {
    "repair-from-log" { $extra += "--migrate-run-mode", "repair-from-log" }
    "overwrite"       { $extra += "--migrate-run-mode", "overwrite" }
    "resume"          { $extra += "--migrate-run-mode", "resume" }
    "full"            { $extra += "--migrate-run-mode", "resume" }
    ""                { }
    default {
      throw "MigrateRunMode must be resume, overwrite, or repair-from-log (got: $MigrateRunMode)"
    }
  }

  $rowMode = if ($MigrateMode) { $MigrateMode.Trim().ToLowerInvariant() } else { "" }
  if ($rowMode -eq "insert-only") {
    $extra += "--migrate-mode", "insert-only"
  }
  elseif ($rowMode -eq "overwrite") {
    $extra += "--migrate-mode", "overwrite"
  }

  $kr = if ($SourceKeyRange) { $SourceKeyRange.Trim() } else { "" }
  if ($kr -ne "") {
    $extra += "--source-key-range", $kr
  }
  else {
    $kf = if ($SourceKeyFrom) { $SourceKeyFrom.Trim() } else { "" }
    $kt = if ($SourceKeyTo) { $SourceKeyTo.Trim() } else { "" }
    if ($kf -ne "") { $extra += "--source-key-from", $kf }
    if ($kt -ne "") { $extra += "--source-key-to", $kt }
  }

  $r = if ($SourceIndexRange) { $SourceIndexRange.Trim() } else { "" }
  if ($r -ne "") {
    $extra += "--source-index-range", $r
  }
  else {
    $sf = if ($SourceIndexFrom) { $SourceIndexFrom.Trim() } else { "" }
    $st = if ($SourceIndexTo) { $SourceIndexTo.Trim() } else { "" }
    if ($sf -ne "") { $extra += "--source-index-from", $sf }
    if ($st -ne "") { $extra += "--source-index-to", $st }
  }

  return $extra
}
