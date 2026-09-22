#Requires -Version 5.1
<#
  รัน migrate ทุกตารางตามลำดับ FK / ความสัมพันธ์ข้อมูล

  ใช้งาน:
    .\run-migrate-all.ps1
    .\run-migrate-all.ps1 -SkipInstall
    .\run-migrate-all.ps1 -StartFrom 3
    .\run-migrate-all.ps1 -LogPath ".\logs\my-run.log"
    .\run-migrate-all.ps1 -Tables appointment,examination
    .\run-migrate-all.ps1 -Tables examination -MigrateRunMode overwrite
    .\run-migrate-all.ps1 -Tables examination -MigrateRunMode repair-from-log
    .\run-migrate-all.ps1 -SourceIndexFrom 100 -SourceIndexTo 200 -SkipInstall

  -StartFrom ดีฟอลต์ = 0 (เริ่มที่ step 0 mobile_location ซึ่งเป็นตาราง lookup เล็ก รันก่อนทุกตาราง)
    ใส่ -StartFrom 1 เพื่อข้าม mobile_location แล้วเริ่มที่ patient_info — เลข step ของตารางเดิมไม่เปลี่ยน

  -MigrateRunMode resume (ดีฟอลต์) = ต่อจาก checkpoint, ไม่ทับแถวที่มีใน Postgres แล้ว
    ก่อนเริ่มจะตรวจ checkpoint กับตารางปลายทาง (scripts/check-resume-checkpoints.mjs):
    ปลายทางว่างแต่มี checkpoint → ย้าย checkpoint ออก (ตารางนั้นเริ่มใหม่) /
    ปลายทางมีข้อมูลแต่ไม่มี checkpoint → หยุดทั้งรอบ
    หลังแต่ละตาราง migrate เสร็จ มีขั้น "เก็บตก" (scripts/catch-up-missing-rows.mjs):
    เทียบ key ต้นทาง ณ snapshot กับ Postgres แล้ว migrate เฉพาะแถวที่ขาด (เช่น CreatedDate ว่าง
    ที่อยู่ก่อน checkpoint) แบบ insert-only — ล้มเหลวแค่ log FAIL ไม่หยุดรอบ; ปิดด้วย -NoCatchUp
  -MigrateRunMode overwrite = migrate ทั้งชุดจากต้น, เขียนทับข้อมูลเดิม
  -MigrateRunMode repair-from-log = เฉพาะ id ที่มีปัญหา จาก log ล่าสุดใน <ตาราง>/js-migrate/logs
  -LogLevel quiet (ดีฟอลต์) = จอแสดงเฉพาะจำนวนต้นทาง, ตารางที่กำลังทำ [n/17], แถบ progress,
    สรุปของแต่ละตาราง และคำเตือน/error — รายละเอียดที่เหลือยังลงไฟล์ log ครบเหมือนเดิม
    normal = เพิ่มบรรทัดรายละเอียดของทุกขั้น, debug = ทุกอย่าง (รวม warning ของ node)
  -SkipInstall = ข้ามการตรวจและรัน npm ที่ root (ต้องมี `node_modules/mssql` และ `pg` ที่ root เองแล้ว)
#>

param(
  [string] $ConfigPath = ".\migration.config.local.json",
  [int] $StartFrom = 0,
  [switch] $SkipInstall,
  [string] $LogPath = "",
  [string[]] $Tables = @(),
  [ValidateSet("", "resume", "overwrite", "repair-from-log", "full")]
  [string] $MigrateRunMode = "",
  [string] $MigrateMode = "",
  [string] $SourceIndexRange = "",
  [string] $SourceIndexFrom = "",
  [string] $SourceIndexTo = "",
  [switch] $NoSnapshotCounts,
  [switch] $NoCatchUp,
  [ValidateSet("", "quiet", "normal", "debug")]
  [string] $LogLevel = ""
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

# quiet (ดีฟอลต์) = จอเหลือ จำนวนต้นทาง + ตารางที่กำลังทำ + progress + สรุป/คำเตือน
# รายละเอียดทั้งหมดยังลงไฟล์ log เสมอ — ดูสดบนจอได้ด้วย -LogLevel normal
$effectiveLogLevel = if ($LogLevel) { $LogLevel.Trim().ToLowerInvariant() } else { "quiet" }
$env:MIGRATE_LOG_LEVEL = $effectiveLogLevel

if (-not [System.IO.Path]::IsPathRooted($ConfigPath)) {
  $ConfigPath = Join-Path $PSScriptRoot $ConfigPath
}
$ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "Config file not found: $ConfigPath"
}

$logDir = Join-Path $PSScriptRoot "logs"
if (-not $LogPath) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $LogPath = Join-Path $logDir "run-migrate-all-$stamp.log"
}
$statusPath = Join-Path $logDir "run-migrate-all.current.txt"

if (-not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Write-MigrateLog {
  param(
    [string] $Message,
    [ValidateSet("INFO", "START", "OK", "FAIL", "SKIP")]
    [string] $Level = "INFO",
    # รายละเอียด: เขียนลงไฟล์ log เสมอ แต่ขึ้นจอเฉพาะโหมด normal/debug
    [switch] $Detail
  )
  $line = "{0:yyyy-MM-dd HH:mm:ss} [{1}] {2}" -f (Get-Date), $Level, $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  if ($Detail -and $effectiveLogLevel -eq "quiet") { return }
  switch ($Level) {
    "FAIL" { Write-Host $line -ForegroundColor Red }
    "OK"   { Write-Host $line -ForegroundColor Green }
    "START" { Write-Host $line -ForegroundColor Cyan }
    default { Write-Host $line }
  }
}

function Set-MigrateStatus {
  param([string] $Text)
  Set-Content -LiteralPath $statusPath -Value $Text -Encoding UTF8
}

# นับจำนวนแถวต้นทาง ณ ปัจจุบันของตารางหนึ่ง (MSSQL เท่านั้น — scripts/run-migrate-source-count.mjs)
# คืนค่าจำนวนแถว (int) หรือ $null เมื่อหาไม่ได้
function Get-SourceCount {
  param(
    [string] $Config,
    [string] $Profile,
    [string] $RepoRoot
  )
  $countScript = Join-Path $RepoRoot "scripts/run-migrate-source-count.mjs"
  if (-not (Test-Path -LiteralPath $countScript)) {
    return $null
  }
  $nodeArgs = @($countScript, '--config', $Config, '--profile', $Profile, '--count-only')
  $prevEap = $ErrorActionPreference
  $count = $null
  try {
    $ErrorActionPreference = 'Continue'
    $lines = & node @nodeArgs 2>&1
    foreach ($line in $lines) {
      $m = [regex]::Match([string]$line, '##SOURCE_COUNT##\s+(\d+)')
      if ($m.Success) { $count = [int64] $m.Groups[1].Value }
    }
  }
  finally {
    $ErrorActionPreference = $prevEap
  }
  return $count
}

# เก็บ key ต้นทาง ณ snapshot ของตารางหนึ่งลงไฟล์ (ใช้ตอนเก็บตกหลังตารางนั้น migrate เสร็จ)
# คืนจำนวน key หรือ $null เมื่ออ่านไม่สำเร็จ (ไฟล์ถูกลบ → ตารางนั้นไม่เก็บตกรอบนี้)
function Save-CatchUpKeys {
  param(
    [string] $Config,
    [string] $ProfileName,
    [string] $RepoRoot,
    [string] $KeysFile
  )
  $script = Join-Path $RepoRoot "scripts/catch-up-missing-rows.mjs"
  if (Test-Path -LiteralPath $KeysFile) { Remove-Item -LiteralPath $KeysFile -Force }
  $prevEap = $ErrorActionPreference
  $count = $null
  try {
    $ErrorActionPreference = 'Continue'
    $lines = & node $script --config $Config --profile $ProfileName --snapshot-keys $KeysFile 2>&1
    foreach ($line in $lines) {
      $m = [regex]::Match([string]$line, '##CATCHUP_KEYS##\s+(\d+)')
      if ($m.Success) { $count = [int64] $m.Groups[1].Value }
    }
  }
  finally {
    $ErrorActionPreference = $prevEap
  }
  if ($null -eq $count -and (Test-Path -LiteralPath $KeysFile)) {
    Remove-Item -LiteralPath $KeysFile -Force
  }
  return $count
}

# ตารางที่เรียงตาม CreatedDate / Exam_ID แล้วมีแถวไปตกก่อน checkpoint ได้ (ดู scripts/catchUpMissingRows.mjs)
$catchUpProfiles = @(
  "patient_info", "examination", "billing", "examination_general", "pacs_sync_info", "procedure",
  "ultrasound", "mam", "mam_cal", "mam_mass", "ultrasound_cyst", "ultrasound_mass"
)
$catchUpDir = Join-Path $logDir "catch-up"
$catchUpScript = Join-Path $PSScriptRoot "scripts/catch-up-missing-rows.mjs"

$steps = @(
  # ตาราง lookup เล็ก ไม่มีตารางอื่นอ้างถึงตอน migrate — เทียบด้วย old_id ทุกรอบ ไม่ใช้ checkpoint
  # เป็น step 0 (ไม่ใช่ 1) เพื่อไม่ต้องเลื่อนเลข step เดิมทั้งชุด — -StartFrom 1 = ข้ามตารางนี้
  @{ N = 0;  Table = "mobile_location";     Profile = "mobile_location";     Script = "mobile-location/js-migrate/run-migrate.ps1" },
  @{ N = 1;  Table = "patient_info";        Profile = "patient_info";        Script = "patient-info/js-migrate/run-migrate.ps1" },
  @{ N = 2;  Table = "appointment";         Profile = "appointment";         Script = "appointment/js-migrate/run-migrate.ps1" },
  @{ N = 3;  Table = "appointment_reschedules"; Profile = "appointment_reschedules"; Script = "appointment-reschedules/js-migrate/run-migrate.ps1" },
  @{ N = 4;  Table = "examination";         Profile = "examination";         Script = "examination/js-migrate/run-migrate.ps1" },
  @{ N = 5;  Table = "billing";             Profile = "billing";             Script = "billing/js-migrate/run-migrate.ps1" },
  @{ N = 6;  Table = "examination_general"; Profile = "examination_general"; Script = "examination-general/js-migrate/run-migrate.ps1" },
  @{ N = 7;  Table = "exam_recommend_birads45"; Profile = "exam_recommend_birads45"; Script = "exam-recommend-birads45/js-migrate/run-migrate.ps1" },
  @{ N = 8;  Table = "pacs_sync_info";      Profile = "pacs_sync_info";      Script = "pacs-sync-info/js-migrate/run-migrate.ps1" },
  @{ N = 9;  Table = "procedure";           Profile = "procedure";           Script = "procedure/js-migrate/run-migrate.ps1" },
  @{ N = 10; Table = "ultrasound";          Profile = "ultrasound";          Script = "ultrasound/js-migrate/run-migrate.ps1" },
  @{ N = 11; Table = "mammogram";           Profile = "mam";                 Script = "mam/js-migrate/run-migrate.ps1" },
  @{ N = 12; Table = "mammogram_cal";       Profile = "mam_cal";             Script = "mam-cal/js-migrate/run-migrate.ps1" },
  @{ N = 13; Table = "mammogram_mass";      Profile = "mam_mass";            Script = "mam-mass/js-migrate/run-migrate.ps1" },
  @{ N = 14; Table = "ultrasound_cyst";     Profile = "ultrasound_cyst";     Script = "ultrasound-cyst/js-migrate/run-migrate.ps1" },
  @{ N = 15; Table = "ultrasound_mass";     Profile = "ultrasound_mass";     Script = "ultrasound-mass/js-migrate/run-migrate.ps1" },
  # อ่าน Postgres ล้วน (ultrasound + examination_general ที่ migrate แล้ว) → ไม่มี source count จาก MSSQL
  @{ N = 16; Table = "birads_mass_cyst";    Profile = "birads_mass_cyst";    Script = "birads-mass-cyst/js-migrate/run-migrate.ps1"; NoSourceCount = $true },
  # ตาราง log ไม่มี PK — ต้องการแค่ patient_info (step 1) จึงต่อท้ายได้ ไม่ต้องเลื่อนเลข step เดิม
  @{ N = 17; Table = "pacs_sync_patient";   Profile = "pacs_sync_patient";   Script = "pacs-sync-patient/js-migrate/run-migrate.ps1" }
)

$tableFilter = foreach ($t in $Tables) {
  if ($null -ne $t -and "$t".Trim() -ne "") { "$t".Trim().ToLowerInvariant() }
}
$runAllTables = ($tableFilter.Count -eq 0)

$repoRoot = $PSScriptRoot
. (Join-Path $repoRoot "scripts\Get-MigrateNodeCliArgs.ps1")
$total = $steps.Count
# ป้ายบอกความคืบหน้าใช้เลข step (เริ่มที่ 0 = mobile_location) ไม่ใช่จำนวนตาราง
$lastStep = ($steps | ForEach-Object { $_.N } | Measure-Object -Maximum).Maximum
$started = Get-Date
$rawRunMode = if ($MigrateRunMode) { $MigrateRunMode.Trim().ToLowerInvariant() } else { "resume" }
$effectiveRunMode = if ($rawRunMode -eq "full") { "resume" } else { $rawRunMode }

Write-MigrateLog "=== BIS migrate all started ($total tables) ==="
Write-MigrateLog "Config: $ConfigPath" -Detail
Write-MigrateLog "Log file: $LogPath"
Write-MigrateLog "Status file: $statusPath" -Detail
if ($StartFrom -gt 0) { Write-MigrateLog "StartFrom step: $StartFrom" }
Write-MigrateLog "MigrateRunMode: $effectiveRunMode (resume=checkpoint+skip-existing, overwrite=full-replace, repair-from-log=ids-from-log)"
$idxRangeLog = if ($SourceIndexRange) { $SourceIndexRange.Trim() } else { "" }
if ($idxRangeLog -eq "") {
  $sf = if ($SourceIndexFrom) { $SourceIndexFrom.Trim() } else { "" }
  $st = if ($SourceIndexTo) { $SourceIndexTo.Trim() } else { "" }
  if ($sf -ne "" -or $st -ne "") {
    $idxRangeLog = "$(if ($sf) { $sf } else { 'all' })-$(if ($st) { $st } else { 'all' })"
  }
}
if ($idxRangeLog -ne "") {
  Write-MigrateLog ('SourceIndexRange: {0} — row index 1-based inclusive, per table ORDER BY' -f $idxRangeLog)
}
if (-not $runAllTables) {
  Write-MigrateLog "Tables filter: $($tableFilter -join ', ') (MSSQL key filter: appointment Schedule_ID / examination Exam_ID)"
}

if (-not $SkipInstall) {
  $ensureDot = Join-Path $repoRoot "scripts/Ensure-MigrateNodeModules.ps1"
  . $ensureDot
  Ensure-MigrateNodeModules -RepoRoot $repoRoot
}

# ── checkpoint ต้องไปด้วยกันกับข้อมูลปลายทาง (resume) ──────────────────────────
# ปลายทางว่างแต่มี checkpoint → ย้าย checkpoint ออก (ตารางนั้นเริ่มใหม่)
# ปลายทางมีข้อมูลแต่ไม่มี checkpoint → หยุดทั้งรอบ (กัน insert ซ้ำ / เขียนทับแถวที่แก้ในระบบใหม่)
$userIndexRangeGiven =
  (($SourceIndexRange) -and ($SourceIndexRange.Trim() -ne "")) -or
  (($SourceIndexFrom) -and ($SourceIndexFrom.Trim() -ne "")) -or
  (($SourceIndexTo) -and ($SourceIndexTo.Trim() -ne ""))
if ($effectiveRunMode -eq "resume" -and -not $userIndexRangeGiven) {
  $checkProfiles = @(
    foreach ($step in $steps) {
      if ($step.N -lt $StartFrom) { continue }
      if (-not $runAllTables -and ($tableFilter -notcontains $step.Table.ToLowerInvariant())) { continue }
      $step.Profile
    }
  )
  if ($checkProfiles.Count -gt 0) {
    $checkScript = Join-Path $repoRoot "scripts/check-resume-checkpoints.mjs"
    $prevEap = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $checkLines = & node $checkScript --config $ConfigPath --tables ($checkProfiles -join ',') 2>&1
      $checkExit = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $prevEap
    }
    foreach ($line in $checkLines) {
      if ("$line".Trim() -ne "") { Write-MigrateLog ("{0}" -f $line) }
    }
    if ($checkExit -ne 0) {
      Write-MigrateLog "checkpoint ไม่ตรงกับข้อมูลปลายทาง — หยุดก่อนเริ่ม (ดูรายละเอียดด้านบน)" -Level FAIL
      Set-MigrateStatus 'FAILED ; checkpoint check'
      throw "checkpoint check failed. See log: $LogPath"
    }
  }
}

# ── Snapshot count ──────────────────────────────────────────────────────────
# ดึงจำนวนแถวต้นทางของทุกตาราง (ที่จะรัน) ณ ตอนเริ่ม แล้วใช้เป็นเพดาน -SourceIndexTo ต่อตาราง
# กัน data ที่ไหลเข้ามาระหว่างรันไม่ให้ถูกดึงเข้ามาแบบไม่สม่ำเสมอ (แถวใหม่อยู่ท้าย ORDER BY → ตัดออก)
$userIndexExplicit =
  (($SourceIndexRange) -and ($SourceIndexRange.Trim() -ne "")) -or
  (($SourceIndexFrom) -and ($SourceIndexFrom.Trim() -ne "")) -or
  (($SourceIndexTo) -and ($SourceIndexTo.Trim() -ne ""))

$countSnapshot = @{}
$doSnapshot = (-not $NoSnapshotCounts) -and (-not $userIndexExplicit) -and ($effectiveRunMode -ne "repair-from-log")

if ($userIndexExplicit) {
  Write-MigrateLog 'Snapshot counts: skipped (ระบุ -SourceIndex* เอง — ใช้ช่วงที่กำหนด)'
}
elseif ($effectiveRunMode -eq "repair-from-log") {
  Write-MigrateLog "Snapshot counts: skipped (repair-from-log)"
}
elseif ($NoSnapshotCounts) {
  Write-MigrateLog "Snapshot counts: skipped (-NoSnapshotCounts)"
}

# เก็บตกใช้ key ที่เก็บพร้อม snapshot count — resume เท่านั้น (overwrite อ่านทั้งตารางอยู่แล้ว)
$doCatchUp = $doSnapshot -and ($effectiveRunMode -eq "resume") -and (-not $NoCatchUp)
$catchUpKeys = @{}
$catchUpFailed = @()
if ($effectiveRunMode -eq "resume" -and -not $doCatchUp) {
  Write-MigrateLog "Catch-up (เก็บตก): skipped"
}

if ($doSnapshot) {
  Set-MigrateStatus ('RUNNING ; snapshot counts ; 0/{0}' -f $lastStep)
  # นับย้อนลำดับ (ตารางลูก → แม่ → patient_info): ต้นทางที่ยังมีคนใช้งาน แถวลูกที่อยู่ใน cap
  # จะมีแถวแม่อยู่ใน cap ของแม่เสมอ (แม่ถูกนับทีหลัง) — ไม่งั้นลูกได้ FK ว่างถาวร
  $snapshotSteps = @($steps)
  [array]::Reverse($snapshotSteps)
  foreach ($step in $snapshotSteps) {
    if ($step.N -lt $StartFrom) { continue }
    if (-not $runAllTables -and ($tableFilter -notcontains $step.Table.ToLowerInvariant())) { continue }
    if ($step.NoSourceCount) { continue }
    $c = Get-SourceCount -Config $ConfigPath -Profile $step.Profile -RepoRoot $repoRoot
    if ($null -ne $c) {
      $countSnapshot[$step.Table] = $c
      Write-MigrateLog ('snapshot count : {0} {1}' -f $step.Table, $c)
    }
    else {
      Write-MigrateLog ('snapshot count : {0} (n/a)' -f $step.Table) -Level SKIP
    }
    # key ต้นทางชุดเดียวกับ count (นับย้อนลำดับเหมือนกัน → ลูกที่อยู่ในไฟล์ มีแม่อยู่ในไฟล์ของแม่)
    if ($doCatchUp -and $null -ne $c -and ($catchUpProfiles -contains $step.Profile)) {
      $keysFile = Join-Path $catchUpDir ("{0}.keys.tsv" -f $step.Profile)
      $k = Save-CatchUpKeys -Config $ConfigPath -ProfileName $step.Profile -RepoRoot $repoRoot -KeysFile $keysFile
      if ($null -ne $k) {
        $catchUpKeys[$step.Profile] = $keysFile
        Write-MigrateLog ('snapshot keys  : {0} {1} (เก็บตก)' -f $step.Table, $k) -Detail
      }
      else {
        Write-MigrateLog ('snapshot keys  : {0} อ่านไม่สำเร็จ — ตารางนี้ไม่เก็บตกรอบนี้' -f $step.Table) -Level SKIP
      }
    }
  }
  $snapshotPath = Join-Path $logDir ("source-count-snapshot-{0}.json" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
  try {
    ($countSnapshot.GetEnumerator() | Sort-Object Name |
      ForEach-Object { [pscustomobject]@{ table = $_.Name; sourceCount = $_.Value } }) |
      ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $snapshotPath -Encoding UTF8
    Write-MigrateLog ('snapshot count : saved {0}' -f $snapshotPath) -Level OK
  }
  catch {
    Write-MigrateLog ('snapshot count : could not save file ({0})' -f $_) -Level SKIP
  }
}

Set-MigrateStatus ('RUNNING ; waiting to start ; 0/{0}' -f $lastStep)

foreach ($step in $steps) {
  if ($step.N -lt $StartFrom) {
    Write-MigrateLog "[$($step.N)/$lastStep] $($step.Table) (skipped, StartFrom=$StartFrom)" -Level SKIP
    continue
  }
  if (-not $runAllTables -and ($tableFilter -notcontains $step.Table.ToLowerInvariant())) {
    Write-MigrateLog "[$($step.N)/$lastStep] $($step.Table) (skipped, not in -Tables)" -Level SKIP
    continue
  }

  $label = "[$($step.N)/$lastStep] $($step.Table)"
  $scriptPath = Join-Path $repoRoot $step.Script
  if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Migration script not found: $scriptPath"
  }

  Set-MigrateStatus ('RUNNING ; {0} ; {1}/{2}' -f $label, $step.N, $lastStep)
  # path แบบสั้น (เทียบ repo) — path เต็มอยู่ใน $scriptPath ตอน throw ถ้าไม่เจอไฟล์
  Write-MigrateLog ('{0} - starting {1}' -f $label, $step.Script) -Level START

  # เดิมให้โฟลเดอร์ที่ 2+ ข้าม npm — ตอนนี้ติดตั้งที่ root แล้วก่อนวนขั้นอยู่ด้านบน → ให้ลูกไม่เรียก npm ซ้ำ
  $invokeArgs = @{
    ConfigPath      = $ConfigPath
    SkipInstall     = $true
    MigrateRunMode  = $effectiveRunMode
  }
  if ($MigrateMode -eq "insert-only") { $invokeArgs.MigrateMode = "insert-only" }
  $skr = if ($SourceIndexRange) { $SourceIndexRange.Trim() } else { "" }
  if ($skr -ne "") {
    $invokeArgs.SourceIndexRange = $skr
  }
  else {
    $sf = if ($SourceIndexFrom) { $SourceIndexFrom.Trim() } else { "" }
    $st = if ($SourceIndexTo) { $SourceIndexTo.Trim() } else { "" }
    if ($sf -ne "") { $invokeArgs.SourceIndexFrom = $sf }
    if ($st -ne "") { $invokeArgs.SourceIndexTo = $st }
    # เพดานจาก snapshot count — ใช้ sourceCountCap (ไม่เปลี่ยนชื่อ checkpoint ไม่กระทบ resume)
    if ($sf -eq "" -and $st -eq "" -and $countSnapshot.ContainsKey($step.Table)) {
      $invokeArgs.SourceCountCap = "$($countSnapshot[$step.Table])"
      Write-MigrateLog ('{0} - cap {1} (snapshot)' -f $label, $countSnapshot[$step.Table]) -Detail
    }
  }

  $stepStarted = Get-Date
  try {
    # สคริปต์ลูกใช้ Set-Location เปลี่ยน cwd ทั้ง session — ต้องกลับ root ก่อนเรียกแต่ละตาราง
    Set-Location -LiteralPath $repoRoot
    & $scriptPath @invokeArgs
    if ($LASTEXITCODE -ne 0) {
      throw "exit code $LASTEXITCODE"
    }
    $stepElapsed = (Get-Date) - $stepStarted
    Write-MigrateLog ('{0} - done in {1}' -f $label, $stepElapsed.ToString('hh\:mm\:ss')) -Level OK
    Set-MigrateStatus ('DONE step ; {0} ; {1}/{2}' -f $label, $step.N, $lastStep)
  }
  catch {
    Write-MigrateLog ('{0} - FAILED: {1}' -f $label, $_) -Level FAIL
    Set-MigrateStatus ('FAILED ; {0} ; {1}/{2}' -f $label, $step.N, $lastStep)
    throw "Migration failed at step $($step.N): $($step.Table). See log: $LogPath"
  }

  # เก็บตก: แถวที่อยู่ใน snapshot แต่ Postgres ยังไม่มี (ตกอยู่ก่อน checkpoint) — ล้มเหลวไม่หยุดรอบ
  if ($catchUpKeys.ContainsKey($step.Profile)) {
    Set-Location -LiteralPath $repoRoot
    Set-MigrateStatus ('RUNNING ; {0} catch-up ; {1}/{2}' -f $label, $step.N, $lastStep)
    $resultFile = Join-Path $catchUpDir ("{0}.result.json" -f $step.Profile)
    if (Test-Path -LiteralPath $resultFile) { Remove-Item -LiteralPath $resultFile -Force }
    $prevEap = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      # เรียกตรงๆ ไม่ pipe / ไม่เก็บค่า — ลูกเขียนลงจอเอง แถบ progress จึงอัปเดตในบรรทัดเดียวได้
      & node $catchUpScript --config $ConfigPath --profile $step.Profile --keys $catchUpKeys[$step.Profile] --result $resultFile
      $cuExit = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $prevEap
    }
    $r = $null
    if (Test-Path -LiteralPath $resultFile) {
      try { $r = Get-Content -LiteralPath $resultFile -Raw -Encoding UTF8 | ConvertFrom-Json }
      catch { $r = $null }
    }
    if ($cuExit -eq 0 -and $null -ne $r -and $r.ok) {
      $msg = if ([int64]$r.missingRows -eq 0) { 'ไม่มีแถวที่ขาด' } else {
        'ขาด {0} แถว → เติม {1}/{2} id' -f $r.missingRows, ([int64]$r.attempted - [int64]$r.remaining), $r.attempted
      }
      if ([int64]$r.partial -gt 0) { $msg += (' ; ข้าม {0} id ที่ Postgres มีบางแถวแล้ว (ไม่เขียนทับ)' -f $r.partial) }
      if ([int64]$r.unsendable -gt 0) { $msg += (' ; ข้าม {0} id ที่ส่งผ่าน --source-ids ไม่ได้' -f $r.unsendable) }
      if ([int64]$r.deferred -gt 0) { $msg += (' ; รอรอบหน้า {0} id' -f $r.deferred) }
      if ([int64]$r.remaining -gt 0) { $msg += (' ; ยังขาด {0} id (ดู field issue log ของตาราง)' -f $r.remaining) }
      Write-MigrateLog ('{0} - เก็บตก: {1}' -f $label, $msg)
    }
    else {
      $why = if ($null -ne $r -and $r.error) { $r.error } else { "exit code $cuExit" }
      Write-MigrateLog ('{0} - เก็บตก FAILED ({1}) — ข้ามไป ไม่หยุดรอบนี้' -f $label, $why) -Level FAIL
      $catchUpFailed += $step.Table
    }
    Set-MigrateStatus ('DONE step ; {0} ; {1}/{2}' -f $label, $step.N, $lastStep)
  }
}

$elapsed = (Get-Date) - $started
if ($catchUpFailed.Count -gt 0) {
  Write-MigrateLog ('เก็บตกล้มเหลว: {0} — migrate ปกติสำเร็จ แต่ตารางเหล่านี้อาจยังขาดแถวที่ตกอยู่ก่อน checkpoint' -f ($catchUpFailed -join ', ')) -Level FAIL
}
Write-MigrateLog "=== All migrations completed in $($elapsed.ToString('hh\:mm\:ss')) ===" -Level OK
$doneStatus = 'ALL DONE ; {0}/{0} tables ; {1}' -f $total, $elapsed.ToString('hh\:mm\:ss')
if ($catchUpFailed.Count -gt 0) { $doneStatus += (' ; catch-up FAILED: {0}' -f ($catchUpFailed -join ',')) }
Set-MigrateStatus $doneStatus
