#Requires -Version 5.1
<#
  รัน migration patient_info เข้า bisinfo_dev_clone ผ่าน kubectl exec -> postgresql-0
  ข้อกำหนด: kubectl พร้อม context ที่เข้า pod ได้, มีไฟล์ CSV อยู่ที่ imports/

  ตัวอย่าง (ราก repo BIS-DB-Migration):
    .\patient-info\run-migrate-clone.ps1
    .\patient-info\run-migrate-clone.ps1 -CsvPath .\patient-info\imports\patient_info.csv
    .\patient-info\run-migrate-clone.ps1 -TruncateFirst
#>
param(
  # ไม่ใส่ = ใช้ imports/patient_info.csv ข้างสคริปต์ (กดรันใน Cursor/VS Code ได้โดยไม่ส่งพารามิเตอร์)
  [string] $CsvPath = "",
  [string] $Namespace = "default",
  [string] $Pod = "postgresql-0",
  # ห้ามใช้ชื่อ Db: ชนกับ alias -db ของ common parameter -Debug ใน PowerShell
  [string] $PostgresDatabase = "bisinfo_dev_clone",
  [string] $User = "devuser",
  [switch] $TruncateFirst
)

$ErrorActionPreference = "Stop"
$sqlDir = Join-Path $PSScriptRoot "sql"
$reportDir = Join-Path $PSScriptRoot "reports"

if ([string]::IsNullOrWhiteSpace($CsvPath)) {
  $CsvPath = Join-Path $PSScriptRoot "imports\patient_info.csv"
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
  Write-Host ">>> TRUNCATE public.patient_info (clone) ..."
  Invoke-PsqlFile "00_truncate_clone_patient_info.sql"
}

Write-Host ">>> 01_create_staging ..."
Invoke-PsqlFile "01_create_staging.sql"

# ไม่ pipe stdin จาก PowerShell ไป psql: บน Windows มักแทรก CR ทำให้ COPY แจ้ง
# "unquoted carriage return found in data" — ใช้ kubectl cp แล้ว \copy จากไฟล์ใน pod แทน
#
# kubectl cp บน Windows มักไม่รู้จัก path แบบ C:\... / C:/... เป็น local file (error: one of src or dest must be a local...)
# → cd ไปที่โฟลเดอร์ของไฟล์ แล้ว cp ด้วย path แบบ relative (ชื่อไฟล์หรือ .\ไฟล์) เท่านั้น
$csvResolved = (Resolve-Path -LiteralPath $CsvPath).Path
$csvDir = Split-Path -Parent $csvResolved
$csvLeaf = Split-Path -Leaf $csvResolved
if ([string]::IsNullOrWhiteSpace($csvLeaf)) {
  throw "ไม่สามารถหาชื่อไฟล์จาก: $CsvPath"
}
$remoteFile = "/tmp/patient_info_migrate_$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()).csv"

$kubectlCpExit = 0
Push-Location -LiteralPath $csvDir
try {
  Write-Host ">>> kubectl cp (cwd=$csvDir) $csvLeaf -> ${Pod}:${remoteFile} (ns $Namespace) ..."
  & kubectl -n $Namespace cp -- "./$csvLeaf" "${Pod}:${remoteFile}"
  $kubectlCpExit = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($kubectlCpExit -ne 0) {
  throw "kubectl cp failed (exit $kubectlCpExit)"
}

try {
  Write-Host ">>> COPY CSV -> migrate_stg.patient_info_mssql ..."
  $copySql = '\copy migrate_stg.patient_info_mssql FROM ''' + $remoteFile + ''' WITH (FORMAT csv, HEADER true, ENCODING ''UTF8'');'
  & kubectl -n $Namespace exec $Pod -- psql -v ON_ERROR_STOP=1 -U $User -d $PostgresDatabase -c $copySql
  if ($LASTEXITCODE -ne 0) { throw "COPY failed" }
}
finally {
  & kubectl -n $Namespace exec $Pod -- rm -f $remoteFile 2>$null
}

Write-Host ">>> 02_insert_into_clone_patient_info ..."
Invoke-PsqlFile "02_insert_into_clone_patient_info.sql"

Write-Host ">>> 03_insert_addresses_from_staging (Directus address) ..."
Invoke-PsqlFile "03_insert_addresses_from_staging.sql"

Write-Host ">>> 04_verify_clone ..."
Invoke-PsqlFile "04_verify_clone.sql"

Write-Host ">>> สร้างรายงานผล migration ..."
$stagingCount = [int64](Invoke-PsqlText "SELECT COUNT(*) FROM migrate_stg.patient_info_mssql;")
$targetCount = [int64](Invoke-PsqlText "SELECT COUNT(*) FROM public.patient_info;")
$matchedCount = [int64](Invoke-PsqlText @"
SELECT COUNT(DISTINCT migrate_stg.norm_pid(s.pid))
FROM migrate_stg.patient_info_mssql s
JOIN public.patient_info p
  ON migrate_stg.norm_pid(p.pid::text) = migrate_stg.norm_pid(s.pid)
WHERE migrate_stg.norm_pid(s.pid) <> '';
"@)
$missingRowsRaw = Invoke-PsqlText @"
SELECT s.pid,
       CASE
         WHEN migrate_stg.norm_pid(s.pid) = '' THEN 'empty_pid_after_trim'
         WHEN EXISTS (
           SELECT 1
           FROM migrate_stg.patient_info_mssql s2
           WHERE migrate_stg.norm_pid(s2.pid) = migrate_stg.norm_pid(s.pid)
             AND s2.pid IS DISTINCT FROM s.pid
         ) THEN 'duplicate_pid_after_trim'
         ELSE 'not_found_in_target'
       END AS reason
FROM migrate_stg.patient_info_mssql s
LEFT JOIN public.patient_info p
  ON migrate_stg.norm_pid(p.pid::text) = migrate_stg.norm_pid(s.pid)
WHERE p.id IS NULL
ORDER BY s.pid;
"@

$missingRows = @()
if (-not [string]::IsNullOrWhiteSpace($missingRowsRaw)) {
  foreach ($line in ($missingRowsRaw -split "`r?`n")) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line -split "`t", 2
    $pid = if ($parts.Count -ge 1) { $parts[0] } else { "" }
    $reason = if ($parts.Count -ge 2) { $parts[1] } else { "not_found_in_target" }
    $missingRows += [pscustomobject]@{
      pid = $pid
      reason = $reason
    }
  }
}

$missingCount = $missingRows.Count
$completedFully = ($missingCount -eq 0)
$generatedAt = (Get-Date).ToString("o")
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

if (-not (Test-Path -LiteralPath $reportDir)) {
  New-Item -Path $reportDir -ItemType Directory | Out-Null
}

$summaryPath = Join-Path $reportDir "patient-info-migrate-summary-$stamp.json"
$missingPath = Join-Path $reportDir "patient-info-migrate-missing-$stamp.txt"

$summary = [ordered]@{
  generatedAt = $generatedAt
  source = "csv_to_migrate_stg.patient_info_mssql"
  target = "public.patient_info"
  stagingCount = $stagingCount
  targetCount = $targetCount
  matchedCount = $matchedCount
  missingCount = $missingCount
  completedFully = $completedFully
  missingRecords = $missingRows
}

$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

$missingLines = @("# pid`treason")
foreach ($row in $missingRows) {
  $missingLines += ("{0}`t{1}" -f $row.pid, $row.reason)
}
$missingLines | Set-Content -LiteralPath $missingPath -Encoding UTF8

Write-Host ">>> สรุปผล migrate"
Write-Host "    - stagingCount: $stagingCount"
Write-Host "    - matchedCount: $matchedCount"
Write-Host "    - missingCount: $missingCount"
Write-Host "    - completedFully: $completedFully"
Write-Host "    - summaryJson: $summaryPath"
Write-Host "    - missingList: $missingPath"

Write-Host "เสร็จแล้ว"
