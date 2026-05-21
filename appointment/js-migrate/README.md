# JS migration - `appointment`

Flow เดียวกับ `examination/js-migrate`:

- ดึงจาก MSSQL แบบแบ่ง chunk (OFFSET ตาม `[Schedule_ID]`)
- ใส่ staging ใน Postgres
- แมปเข้า `public.appointment` ผ่าน `appointmentMapping.mjs`
- รองรับ checkpoint + rollback ราย chunk
- log รายรันพร้อม `chunkLogMode` / `chunkSampleEvery` / `sourceLimit` / `probeTiming` (เทียบ `examination`)

## ไฟล์สำคัญ

- `migrate-from-mssql.mjs` - ตัวรันหลัก
- `mssqlAppointmentSelect.mjs` - SELECT จาก `dbo.schedule`
- `appointmentPgDdl.mjs` - staging `migrate_stg.appointment_mssql`
- `appointmentMapping.mjs` - แมป + insert ไป `public.appointment`
- `run-migrate.ps1` - one-click บน PowerShell
- config กลางที่ root: `migration.config.local.json` (profile `appointment`)

## ถ้า Error: `Profile 'appointment' not found in config.profiles`

ไฟล์ `migration.config.local.json` ยังไม่มี `profiles.appointment` — แก้หนึ่งทาง:

- เปิด `migration.config.example.json` คัดลอก block `"appointment": { ... }` ใส่ใน `migration.config.local.json` ภายใต้ `profiles`
- หรือรันซ้ำ: สคริปต์รองรับไม่ใส่ profile นี้ได้ (ใช้ `shared` อย่างเดียว) แต่ยังส่ง log เตือน

## Run

แพ็กเกจ `mssql` / `pg` อยู่ที่ **`npm install` ครั้งเดียวที่ root repo** — ไม่ต้อง `npm install` ในโฟลเดอร์นี้อีก (`run-migrate.ps1` จะติดตั้งให้ที่ root เมื่อยังไม่ครบ ถ้าไม่ใส่ `-SkipInstall`)

```powershell
cd <root ของ repo>
npm install
npm run migrate:appointment
```

หรือ PowerShell พร้อมช่วง `Schedule_ID` และโหมดแถว:

```powershell
cd .\appointment\js-migrate
.\run-migrate.ps1 -ConfigPath "..\..\migration.config.local.json" -Profile appointment `
  -SourceKeyRange "1-100"

# เฉพาะคิวที่ยังไม่มีใน Postgres (ไม่เรียก UPDATE เดิม)
.\run-migrate.ps1 -MigrateMode insert-only -SourceKeyFrom 101 -SourceKeyTo 150
```

แบบ `node` โดยตรง (`overwrite` = ไม่ใส่ flag) จาก root ของ repo:

```text
node appointment/js-migrate/migrate-from-mssql.mjs --config ./migration.config.local.json --profile appointment --migrate-mode insert-only --source-key-range 1-500
```

หรือ Task ใน VS Code/Cursor: **migrate: appointment** (`.vscode/tasks.json`)

## ปรับพฤติกรรม (ใน `profiles.appointment.migration` หรือ `shared.migration`)

- `migrateRowMode`: `overwrite` (ดีฟอลต์) หรือ `insert-only` — จาก CLI มีเฉพาะ `insert-only` (`--migrate-mode insert-only`)
- `sourceKeyNumericMin` / `sourceKeyNumericMax` — จำกัดช่วง `Schedule_ID` ฝั่ง MSSQL (เลขทั้งชุด, inclusive) เทียบ `CAST([Schedule_ID] AS BIGINT)`
- `batchSize` — ขนาด chunk
- `chunkLogMode`: `compact` (แนะนำ), `full`, `none`
- `chunkSampleEvery` — ในโหมด `compact` เก็บรายละเอียด chunk ทุกๆ N
- `sourceLimit` — จำกัดจำนวนแถวทั้ง job (สำหรับทดสอบ)
- `startOffset` — เริ่ม OFFSET ฝั่ง MSSQL โดยตรง (ไม่ใช้ checkpoint)
- `probeTiming` — ล็อกเวลา query MSSQL ราย chunk
- `enableCheckpoint` — ค่า `false` จะไม่เขียน/อ่าน checkpoint
- `checkpointDir` — โฟลเดอร์ checkpoint (default `./checkpoints`)

## ตำแหน่งไฟล์

- log: `logs/migrate-*.json`
- checkpoint: `checkpoints/appointment.json` (หรือ `checkpoints/appointment-<โหมด>-from..-to..json` เมื่อมี `--source-key-range` / `insert-only`)

## หมายเหตุ

- งานนี้ใช้ pagination แบบ OFFSET; ตารางใหญ่มากอาจช้า — รอบหน้าสามารถเพิ่ม keyset ตาม `Schedule_ID` ได้ถ้าต้องการ
- โหมด **two-step** (ดึง ID ก่อนแล้วค่อยดึงรายละเอียด): ถ้ามีหลายแถวต่อ `Schedule_ID` ฝั่ง MSSQL จำนวนแถวจาก `IN (...)` อาจมากกว่าหน้า keyset — **progress / `offset` ใน checkpoint นับตามแถวลำดับ keyset** (ให้ตรง `COUNT(*)` และตำแหน่ง resume) ไม่ใช่จำนวนแถวจาก detail query
- ไม่ล้าง `public.appointment` ทั้งตารางอัตโนมัติ — upsert ตาม `old_db_id` (UPDATE คง `id` / INSERT แถวใหม่) เพื่อไม่ให้ `id` กระโดดเมื่อรัน migrate ซ้ำ
