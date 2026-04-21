#Requires -Version 5.1
<#
  Migration examination เข้า bisinfo_dev_clone (กระบวนการ CSV แบบเดียว patient-info)
  ตัวอย่าง:
    .\examination\run-migrate-examination.ps1
    .\examination\run-migrate-examination.ps1 -CsvPath .\examination\imports\examination.csv
    .\examination\run-migrate-examination.ps1 -TruncateFirst
#>
param(
  [string] $CsvPath = "",
  [string] $Namespace = "default",
  [string] $Pod = "postgresql-0",
  [string] $PostgresDatabase = "bisinfo_dev_clone",
  [string] $User = "devuser",
  [switch] $TruncateFirst
)

$ErrorActionPreference = "Stop"
$sqlDir = Join-Path $PSScriptRoot "sql"
$reportDir = Join-Path $PSScriptRoot "reports"

if ([string]::IsNullOrWhiteSpace($CsvPath)) {
  $CsvPath = Join-Path $PSScriptRoot "imports\examination.csv"
}

if (-not (Test-Path -LiteralPath $CsvPath)) {
  Write-Error "ไม่พบไฟล์ CSV: $CsvPath"
}

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
  Write-Error "ไม่พบ kubectl ใน PATH"
}

function Invoke-PsqlFile([string] $RelativeSqlPath) {
  $full = Join-Path $sqlDir $RelativeSqlPath
  if (-not (Test-Path -LiteralPath $full)) {
    Write-Error "ไม่พบไฟล์ SQL: $full"
  }
  Get-Content -LiteralPath $full -Raw -Encoding UTF8 | & kubectl -n $Namespace exec -i $Pod -- psql -v ON_ERROR_STOP=1 -U $User -d $PostgresDatabase
  if ($LASTEXITCODE -ne 0) { throw "psql failed: $RelativeSqlPath" }
}

function Invoke-PsqlText([string] $Sql) {
  $result = & kubectl -n $Namespace exec -i $Pod -- psql -v ON_ERROR_STOP=1 -U $User -d $PostgresDatabase -A -t -F "`t" -c "$Sql"
  if ($LASTEXITCODE -ne 0) { throw "psql query failed" }
  return ($result -join "`n").Trim()
}

if ($TruncateFirst) {
  Write-Host ">>> TRUNCATE public.examination (clone) ..."
  Invoke-PsqlFile "00_truncate_clone_examination.sql"
}

Write-Host ">>> 01_create_staging ..."
Invoke-PsqlFile "01_create_staging.sql"

$csvResolved = (Resolve-Path -LiteralPath $CsvPath).Path
$csvDir = Split-Path -Parent $csvResolved
$csvLeaf = Split-Path -Leaf $csvResolved
if ([string]::IsNullOrWhiteSpace($csvLeaf)) {
  throw "ไม่สามารถหาชื่อไฟล์จาก: $CsvPath"
}
$remoteFile = "/tmp/examination_migrate_$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()).csv"

$kubectlCpExit = 0
Push-Location -LiteralPath $csvDir
try {
  Write-Host ">>> kubectl cp $csvLeaf -> ${Pod}:${remoteFile} ..."
  & kubectl -n $Namespace cp -- "./$csvLeaf" "${Pod}:${remoteFile}"
  $kubectlCpExit = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($kubectlCpExit -ne 0) {
  throw "kubectl cp failed (exit $kubectlCpExit)"
}

try {
  Write-Host ">>> COPY CSV -> migrate_stg.examination_mssql ..."
  $copySql = '\copy migrate_stg.examination_mssql FROM ''' + $remoteFile + ''' WITH (FORMAT csv, HEADER true, ENCODING ''UTF8'');'
  & kubectl -n $Namespace exec $Pod -- psql -v ON_ERROR_STOP=1 -U $User -d $PostgresDatabase -c $copySql
  if ($LASTEXITCODE -ne 0) { throw "COPY failed" }
}
finally {
  & kubectl -n $Namespace exec $Pod -- rm -f $remoteFile 2>$null
}

Write-Host ">>> 02_insert_into_clone_examination ..."
Invoke-PsqlFile "02_insert_into_clone_examination.sql"

Write-Host ">>> 03_verify_examination ..."
Invoke-PsqlFile "03_verify_examination.sql"

Write-Host ">>> สร้างรายงานผล migration ..."
$stagingCount = [int64](Invoke-PsqlText "SELECT COUNT(*) FROM migrate_stg.examination_mssql;")
$targetCount = [int64](Invoke-PsqlText "SELECT COUNT(*) FROM public.examination;")
$matchedCount = [int64](Invoke-PsqlText @"
SELECT COUNT(DISTINCT migrate_stg.norm_exam_id(s.exam_id))::bigint
FROM migrate_stg.examination_mssql s
JOIN public.examination e
  ON e.old_exam_id = (NULLIF(migrate_stg.norm_exam_id(s.exam_id), '')::bigint)::text
WHERE NULLIF(migrate_stg.norm_exam_id(s.exam_id), '') ~ '^[0-9]+$';
"@)

$missingCount = [int64](Invoke-PsqlText @"
SELECT COUNT(*)::bigint
FROM migrate_stg.examination_mssql s
LEFT JOIN public.examination e
  ON e.old_exam_id = (NULLIF(migrate_stg.norm_exam_id(s.exam_id), '')::bigint)::text
WHERE e.id IS NULL;
"@)

# ตัวอย่างใน JSON เท่านั้น (แถวเยอะมากจะทำให้สคริปต์ค้าง — รายการเต็มอยู่ในไฟล์ .txt)
$missingSampleRaw = Invoke-PsqlText @"
SELECT s.exam_id,
  CASE
    WHEN NULLIF(migrate_stg.norm_exam_id(s.exam_id), '') !~ '^[0-9]+$' THEN 'invalid_exam_id'
    WHEN migrate_stg.norm_pid(s.pid) = '' THEN 'empty_pid'
    WHEN NOT EXISTS (
      SELECT 1 FROM public.patient_info p
      WHERE migrate_stg.norm_pid(p.pid::text) = migrate_stg.norm_pid(s.pid)
    ) THEN 'patient_not_found'
    ELSE 'unknown'
  END AS reason
FROM migrate_stg.examination_mssql s
LEFT JOIN public.examination e
  ON e.old_exam_id = (NULLIF(migrate_stg.norm_exam_id(s.exam_id), '')::bigint)::text
WHERE e.id IS NULL
ORDER BY s.exam_id
LIMIT 200;
"@

$missingRows = @()
if (-not [string]::IsNullOrWhiteSpace($missingSampleRaw)) {
  foreach ($line in ($missingSampleRaw -split "`r?`n")) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line -split "`t", 2
    $examId = if ($parts.Count -ge 1) { $parts[0] } else { "" }
    $reason = if ($parts.Count -ge 2) { $parts[1] } else { "unknown" }
    $missingRows += [pscustomobject]@{
      exam_id = $examId
      reason = $reason
    }
  }
}

$completedFully = ($missingCount -eq 0)
$generatedAt = (Get-Date).ToString("o")
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

if (-not (Test-Path -LiteralPath $reportDir)) {
  New-Item -Path $reportDir -ItemType Directory | Out-Null
}

$summaryPath = Join-Path $reportDir "examination-migrate-summary-$stamp.json"
$missingPath = Join-Path $reportDir "examination-migrate-missing-$stamp.txt"

$missingSqlFile = Join-Path $sqlDir "04_report_missing_select.sql"
Write-Host "    (เขียนรายการ missing ทั้งหมดลงไฟล์ — อาจใช้เวลาถ้ามีแถวมาก)"
"# exam_id`treason" | Set-Content -LiteralPath $missingPath -Encoding UTF8
Get-Content -LiteralPath $missingSqlFile -Raw -Encoding UTF8 | & kubectl -n $Namespace exec -i $Pod -- psql -v ON_ERROR_STOP=1 -U $User -d $PostgresDatabase -A -t -F "`t" -f - | Add-Content -LiteralPath $missingPath -Encoding UTF8
# ไม่ตรวจ $LASTEXITCODE หลัง pipeline (PowerShell อาจไม่สะท้อน exit ของ kubectl)

$summary = [ordered]@{
  generatedAt = $generatedAt
  source = "csv_to_migrate_stg.examination_mssql"
  target = "public.examination"
  stagingCount = $stagingCount
  targetCount = $targetCount
  matchedCount = $matchedCount
  missingCount = $missingCount
  completedFully = $completedFully
  missingRecordsSampleMax = 200
  missingRecordsTruncated = ($missingCount -gt 200)
  missingRecords = $missingRows
  missingListFile = (Split-Path -Leaf $missingPath)
}

$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

Write-Host ">>> สรุปผล migrate"
Write-Host "    - stagingCount: $stagingCount"
Write-Host "    - matchedCount: $matchedCount"
Write-Host "    - missingCount: $missingCount"
Write-Host "    - completedFully: $completedFully"
Write-Host "    - summaryJson: $summaryPath"
Write-Host "    - missingList: $missingPath"

Write-Host "เสร็จแล้ว"
