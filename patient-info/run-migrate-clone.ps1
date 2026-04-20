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

Write-Host ">>> 04_verify_clone ..."
Invoke-PsqlFile "04_verify_clone.sql"

Write-Host "เสร็จแล้ว"
