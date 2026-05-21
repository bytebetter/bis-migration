# JS migration - `examination`

โฟลเดอร์นี้เป็น flow ใหม่แบบเดียวกับ `patient-info/js-migrate`:

- ดึงจาก MSSQL แบบแบ่ง chunk
- ใส่ staging ใน Postgres
- แมปเข้า `public.examination` ผ่านฟังก์ชัน JS
- รองรับ checkpoint + rollback ราย chunk

## ไฟล์สำคัญ

- `migrate-from-mssql.mjs` - ตัวรันหลัก
- `mssqlExaminationSelect.mjs` - SELECT จาก MSSQL
- `examinationPgDdl.mjs` - สร้าง `migrate_stg` + `norm_exam_id`/`norm_pid` + staging table
- `examinationMapping.mjs` - logic map จากแถวดิบ -> `public.examination`
- `run-migrate.ps1` - one-click runner บน PowerShell
- config กลางที่ root: `migration.config.local.json` (profile `examination`)

## Run

`npm install` ใช้ที่ **root repo** ครั้งเดียว — `run-migrate.ps1` ช่วยติดตั้งให้ที่ root เมื่อยังไม่ครบ (ถ้าไม่ `-SkipInstall`)

```powershell
cd <root ของ repo>
npm install
npm run migrate:examination
```

โหมดแถวและช่วง `[Exam_ID]` (เลขทั้งชุด, inclusive):

```powershell
cd .\examination\js-migrate
.\run-migrate.ps1 -SourceKeyRange "1-2000"
.\run-migrate.ps1 -MigrateMode insert-only -SourceKeyFrom 3000 -SourceKeyTo 3099
```

`node` โดยตรง (จาก root ของ repo):

```text
node examination/js-migrate/migrate-from-mssql.mjs --config ./migration.config.local.json --profile examination --source-key-range 10-20
```

## หมายเหตุ

- ถ้าเจอ `ETIMEOUT` / timeout 15 วินาทีจาก MSSQL: ตั้ง `shared.source.requestTimeout` ใน `migration.config.local.json` (มิลลิวินาที) หรืออัปเดตโค้ดให้ใช้ default 5 นาที
- สคริปต์นี้ไม่ล้าง `public.examination` อัตโนมัติ
- ถ้าจะรันใหม่แบบฐานว่าง ให้ `TRUNCATE` เองก่อนรัน
- log อยู่ใน `logs/migrate-*.json`
- checkpoint อยู่ใน `checkpoints/examination.json` (หรือชื่อแยกเมื่อใช้โหมด/ช่วงคีย์จาก CLI)
