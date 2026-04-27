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

```powershell
cd .\appointment\js-migrate
npm install
npm run migrate
```

หรือ Task ใน VS Code/Cursor: **migrate: appointment → Postgres (js-migrate)** (`.vscode/tasks.json`)

## ปรับพฤติกรรม (ใน `profiles.appointment.migration` หรือ `shared.migration`)

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
- checkpoint: `checkpoints/appointment.json`

## หมายเหตุ

- งานนี้ใช้ pagination แบบ OFFSET; ตารางใหญ่มากอาจช้า — รอบหน้าสามารถเพิ่ม keyset ตาม `Schedule_ID` ได้ถ้าต้องการ
- ไม่ล้าง `public.appointment` ทั้งตารางอัตโนมัติ (ลบเฉพาะ `old_db_id` ที่ซ้ำใน chunk นั้นก่อน insert)
