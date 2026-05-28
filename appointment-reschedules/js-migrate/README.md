# JS migration — `appointment_reschedules` (dbo.SCHEDULE_LOG)

Flow เดียวกับ `procedure/js-migrate` และ `appointment/js-migrate`:

- ดึงจาก MSSQL แบบแบ่ง chunk (**keyset DESC** — `LogTime` ใหม่→เก่า แล้ว `Schedule_ID`, `Schedule_Datetime`, `ModifiedDate`, `Old_Schedule_Datetime`; `id` ต่ำใน Postgres ≈ log ล่าสุดใน MSSQL)
- กรองเฉพาะ `[Activity] = N'ย้ายวันนัด'`
- แมปจาก recordset ตรงเข้า `public.appointment_reschedules` ผ่าน `appointmentReschedulesMapping.mjs` (ไม่เขียน staging ต่อ chunk เพื่อลด I/O Postgres)
- รองรับ checkpoint + rollback ราย chunk

## ไฟล์สำคัญ

- `migrate-from-mssql.mjs` — entry
- `mssqlAppointmentReschedulesSelect.mjs` — SELECT `dbo.SCHEDULE_LOG`
- `appointmentReschedulesPgDdl.mjs` — schema + index ปลายทาง
- `appointmentReschedulesMapping.mjs` — แมปฟิลด์ + `Schedule_ID` → `appointment.old_db_id`
- `run-migrate.ps1` — runner
- Config ที่ root: `migration.config.local.json` (profile `appointment_reschedules`)

## ข้อจำเป็นก่อนรัน

1. Migrate `appointment` แล้ว — ใช้ `appointment.old_db_id` = `Schedule_ID`
2. ตาราง `time_slot` ต้องมีข้อมูล master (แมปเวลาจาก `Schedule_Datetime`)

## ความต่างจากตารางทั่วไป (ข้อมูลต้นทาง)

| จุด                | รายละเอียด                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ตาราง MSSQL        | `dbo.SCHEDULE_LOG` (log) ไม่ใช่ `dbo.schedule`                                                                                                                                                                                                                                                                                                                                               |
| กรองแถว            | เฉพาะ `Activity = 'ย้ายวันนัด'`                                                                                                                                                                                                                                                                                                                                                              |
| ไม่มี PK เดียว     | ใช้ `log_key` = `LogTime \| Schedule_ID \| Schedule_Datetime` สำหรับ dedupe / repair                                                                                                                                                                                                                                                                                                         |
| ปลายทาง            | **INSERT ทุกแถวจาก MSSQL** (ไม่ dedupe `log_key` / ไม่ข้ามคีย์ซ้ำ) — หา `appointment` ไม่เจอให้ `appointment = NULL`                                                                                                                                                                                                                                                                         |
| รัน migrate ซ้ำ    | จะได้แถวซ้ำใน Postgres (ล้างตารางก่อนถ้าต้องการชุดเดียว)                                                                                                                                                                                                                                                                                                                                     |
| จำนวนแถว           | ค่าเริ่มต้นใช้ **connection เดียว + T-SQL SNAPSHOT** ให้ `COUNT` กับทุกครั้งที่ดึงแถวอยู่ในสแนปช็อตเดียวกัน → เลขใน plan กับแถวที่อ่านควร**เท่ากัน** (`ALLOW_SNAPSHOT_ISOLATION ON`). ถ้า SNAPSHOT **ไม่เริ่มได้** สคริปต์จะ fallback: ช่วงที่อ่าน keyset ใช้หลายนาที ถ้ามี INSERT ที่เข้าเงื่อนไขเดียวกันระหว่างรัน จำนวนที่อ่านได้อาจ **มากกว่า** `COUNT` ตอนเริ่ม (ไม่เกี่ยวกับ Directus) |
| ทางเลือก NOLOCK    | `mssqlUseNolock: true` เฉพาะเมื่อต้องการ `WITH (NOLOCK)` — ทำให้ COUNT กับ fetch เหลื่อมกันได้ง่ายขึ้น                                                                                                                                                                                                                                                                                       |
| ขาดแถวหลัง migrate | ถ้าอ่านน้อยกว่า COUNT — ลบ checkpoint, `TRUNCATE` ปลายทาง แล้วรัน `--migrate-run-mode overwrite`                                                                                                                                                                                                                                                                                             |
| `appointed_by`     | ปล่อย `NULL` ตอน migrate                                                                                                                                                                                                                                                                                                                                                                     |

ถ้าไม่ได้ตั้ง `profiles.appointment_reschedules.migration.batchSize` สคริปต์นี้จะ **ยก chunk ขั้นต่ำเป็น 8000** (สูงสุด 20000) แม้ `shared.migration.batchSize` จะเป็น 2000 — เพื่อลดจำนวนรอบและ overhead ต่อ chunk

ตั้ง `profiles.appointment_reschedules.migration.batchSize` เองได้ (เช่น 2000 ถ้าต้องการ chunk เล็ก)

ถ้า migrate ชุดใหญ่ช้าช่วงท้าย (~แสนแถวขึ้นไป) แนะนำสร้าง index บน MSSQL:

```sql
CREATE NONCLUSTERED INDEX IX_SCHEDULE_LOG_reschedule_keyset
  ON dbo.SCHEDULE_LOG ([LogTime] DESC, [Schedule_ID] DESC, [Schedule_Datetime] DESC, [ModifiedDate] DESC, [Old_Schedule_Datetime] DESC)
  WHERE [Activity] = N'ย้ายวันนัด';
```

หลังเปลี่ยนลำดับ keyset (เช่นเพิ่ม `Old_Schedule_Datetime` ใน cursor): ลบ `checkpoints/appointment_reschedules.json`, `TRUNCATE public.appointment_reschedules`, รัน `--migrate-run-mode overwrite`

## Run

```powershell
cd <root ของ repo>
npm install
npm run migrate:appointment_reschedules
```

Log: `logs/migrate-*.json` · checkpoint: `checkpoints/appointment_reschedules.json`
