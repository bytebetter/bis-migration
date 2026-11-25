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

# เฉพาะคิวที่ยังไม่มีใน Postgres (ไม่เรียก UPDATE แถวจริงเดิม; placeholder ไม่ทราบชื่อจาก examination ยังคงไว้และ INSERT จาก MSSQL ได้)
.\run-migrate.ps1 -MigrateMode insert-only -SourceKeyFrom 101 -SourceKeyTo 150
```

แบบ `node` โดยตรง (`overwrite` = ไม่ใส่ flag) จาก root ของ repo:

```text
node appointment/js-migrate/migrate-from-mssql.mjs --config ./migration.config.local.json --profile appointment --migrate-mode insert-only --source-key-range 1-500
```

หรือ Task ใน VS Code/Cursor: **migrate: appointment** (`.vscode/tasks.json`)

## ปรับพฤติกรรม (ใน `profiles.appointment.migration` หรือ `shared.migration`)

- `migrateRowMode`: `overwrite` (ดีฟอลต์) หรือ `insert-only` — จาก CLI มีเฉพาะ `insert-only` (`--migrate-mode insert-only`); โหมด resume ไม่ทับแถวจริงเดิม แต่ยัง INSERT แถว MSSQL ได้แม้มี placeholder `ไม่ทราบชื่อ` อยู่แล้ว (จาก `examination`)
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
- **แถวที่ `PID` ว่าง (NULL / `''` / เว้นวรรค)** แยกใน `partitionAppointmentRowsByPid` ก่อนแมป:
  - **ทุกแถว** (รวมวันหยุด/กันช่อง เช่น `วันหยุด ...`, `-`, `OFF` — ไม่กรอง ตามที่ตกลง 2026-10-20) → ผูกคนไข้ K (`shared/js-migrate/scheduleKPatient.mjs`) แบบเดียวกับ flow [id-36] ของระบบใหม่: `pid` = `K` + `patient_info.id`, `created_by_queue_type` = `K`, ชื่อ/นามสกุล/คำนำหน้าจากนัด, `Mobile` → `mobile_phone`, `Telephone` → `phone_home`
    - **ก่อนสร้าง K** นัดที่มีทั้งชื่อและนามสกุล → หาคนไข้จริงใน `public.patient_info` ด้วยชื่อ + นามสกุล (ตัด BOM / ยุบช่องว่างทั้งสองฝั่ง; ไม่นับคนไข้ K `pid = 'K' || id` และ placeholder `ไม่ทราบชื่อ`) — ตกลง 2026-10-21
      - ตรงคนเดียว → ผูกคนนั้นเลย
      - ตรงหลายคน → เบอร์ของนัด (`Mobile` / `Telephone`) ต้องตรง `mobile_phone` / `phone_home` / `phone_biz` (ช่องเดียวหลายเบอร์ได้, `+66` = `0`) เหลือคนเดียวจึงผูก; ไม่มีเบอร์ / ยังหลายคน → สร้าง K (นับใน `nameAmbiguousRows`)
      - นัดที่ไม่มี PID ใช้ `Patient_Type` ทับ `patient_info.patient_category` ได้เฉพาะเมื่อผูก K — คนไข้จริงที่ได้จากชื่อ / exam ไม่ถูกทับ
    - K ที่ migration สร้างระบุได้ด้วย `pid = 'K' || id AND old_db_id = pid` (K ที่ระบบใหม่สร้างเอง `old_db_id` ว่าง — ไม่ถูกจับคู่/ลบ)
    - ชื่อ + นามสกุล (ว่างได้) + เบอร์ (ตัวเลข ≥ 9 หลัก มือถือก่อน ไม่มีใช้เบอร์บ้าน) ตรงกัน = คนเดียวกัน ใช้ K เดิม; ไม่มีชื่อหรือไม่มีเบอร์ → สร้าง K ใหม่ทุกนัด
    - placeholder ที่ examination สร้างไว้และ exam ชี้คนไข้คนเดียว → ใช้คนไข้ของ exam แทนการสร้าง K
    - นัดที่มีอยู่แล้วและผูกคนไข้อยู่ → ใช้คนเดิม (รันซ้ำไม่สร้าง K เพิ่ม)
  - ต้นทางเติม PID ให้นัดที่ผูก K ทีหลัง (คนไข้ใหม่มาลงทะเบียนวันนัด) → เก็บตก (`catchUpMissingRows.mjs`) ถือว่านัดนั้นยังขาด → `--source-ids` ย้ายนัดไปคนไข้จริง (insert-only แก้แค่คอลัมน์ patient)
  - exam ของนัดที่ผูก K มีคนไข้จริง → step examination ย้ายนัดไปคนไข้ของ exam (exam ใน chunk ชี้หลายคน = ไม่ย้าย)
  - ท้าย job appointment ทุกรอบ: K จากรอบก่อนที่ตอนนี้มีคนไข้จริงชื่อ + นามสกุลตรง (กติกาเดียวกับด้านบน) → ย้ายนัดที่มาจาก migration (`old_db_id` ไม่ว่าง) ไปคนไข้จริง เช่น ไม่มาตามนัดแรกแล้วไปลงทะเบียนตอนนัดถัดไป — K ที่ `user_updated` ไม่ว่าง (แก้ในระบบใหม่แล้ว) ไม่แตะ
  - K ที่นัดย้ายออกแล้ว ลบท้าย job ถ้าไม่มีตารางไหนอ้างถึง (FK + `directus_relations`) และ `user_updated` ว่าง — FK ทุกตัวเป็น `ON DELETE SET NULL` จึงต้องเช็คก่อนลบ
  - สรุปต่อรอบ: `nameMatchedRows`, `nameAmbiguousRows`, `kLinkedRows`, `kPatientsCreated`, `kPatientsReused`, `kFromExamRows`, `relinkedFromK`, `relinkedFromKByName`, `kPatientsDeleted` ใน `logs/migrate-*.json`
  - `Schedule_ID` เดียวกันที่มีทั้งแถว PID ว่างและแถวที่มี PID จะใช้แถวที่มี PID
  - `public.patient_info` มีแถวมากกว่า `dbo.patient_info` เท่าจำนวน K (นัดที่ผูกคนไข้จริงจากชื่อไม่สร้าง K); `public.appointment` มีทุก `Schedule_ID` แล้ว (ไม่ต้องหักแถว PID ว่างตอนเทียบจำนวนอีก)
  - แถวที่มี PID แต่หาไม่เจอใน `public.patient_info` **ไม่ถูกข้าม** — ยัง insert โดย `patient` = NULL และลง log เป็น `patient_not_resolved` เหมือนเดิม
  - ท้าย job examination ทุกรอบ (รวมเก็บตก): นัดที่มาจาก migration (`old_db_id` ไม่ว่าง) ยังเป็น `ยังไม่ถึงเวลานัด/ยังไม่มา` แต่มี exam ที่ migrate มา (`old_exam_id` ไม่ว่าง) ชี้อยู่ → `เสร็จสิ้น` (นับใน `appointmentsCompleted`) — สถานะอื่นไม่แตะ, นัดที่ไม่มี exam ปล่อยให้ flow `[id-15]<CRONJOB>` ของระบบใหม่ (23:50 น.) เปลี่ยนเป็น `ไม่มาตามนัด` เอง
  - `examination` ยังสร้าง appointment placeholder (`ไม่ทราบชื่อ` / `Schedule ID <id>`) ให้ `Schedule_ID` ที่อ้างถึงแต่ไม่มีใน `public.appointment` ตาม `ENSURE_PLACEHOLDER_APPOINTMENT_ENABLED`
- ท้าย job appointment ทุกรอบ (รวมเก็บตก): `old_login_name` → ชื่อเต็มจาก `dbo.USER` ต้นทาง — `UserName` → `old_login_name_full_th`, `EngUserName` → `old_login_name_full_en` (เทียบ `LoginName` ไม่สนตัวพิมพ์ / ช่องว่างหัวท้าย; ค่าเก็บตามต้นทาง รวมคำนำหน้า เช่น `พญ.` และรหัสในวงเล็บ)
  - ทับเมื่อชื่อต่างจากต้นทาง (ต้นทางแก้ชื่อ user → รอบถัดไปตาม) — รอบแรกเติมทั้งตาราง, รอบต่อไปแตะแค่นัดใหม่/ชื่อที่เปลี่ยน; login ที่ไม่มีใน `dbo.USER` ไม่แตะ
  - ปลายทางยังไม่มี 2 คอลัมน์นี้ → ข้าม (ไม่ล้ม); อ่าน `dbo.USER` ไม่ได้ → คำเตือน + `loginNameFullError` ใน `logs/migrate-*.json` แต่ job ไม่ล้ม; จำนวนที่เติมอยู่ใน `loginNameFullFilled`
- ท้าย job appointment และ examination ทุกรอบ (รวมเก็บตก): นัด BX ที่ย้ายมา (`old_db_id` ไม่ว่าง + `inventional = 1` หรือ `request = bx`) → สร้าง `nurse_work` แบบ flow `[id-78]` ของระบบใหม่ (`shared/js-migrate/migratedBxNurseWork.mjs`) — ตกลง 2026-11-23
  - `nurse_work.appointment` = นัด, `status` = `2` (เสร็จสิ้น), `bx_status` = `0` (สร้างนัดหมาย BX สำเร็จ), `appointment_datetime` = เวลานัด, `appointed_dept` = `nurse`; `appointment.appointment_status` ไม่แตะ
  - `appointment.department_bx` = `nurse` (DB เก่าไม่มีแผนก — fix ไปก่อน) เติมพร้อมสร้าง nurse_work เฉพาะที่ยังว่าง
  - ไม่ขึ้นคิวงาน "สร้างนัดหมาย" ของพยาบาล (ต้องมี `date_created` และ status เสร็จสิ้นต้องสร้างวันนี้) — ขึ้นแท็บ "นัดทำหัตถการ" ตามวันนัด
  - นัดละ 1 แถว — นัดที่มี `nurse_work` แล้วข้าม (ค่าที่แก้ในระบบใหม่ไม่ถูกทับ); นัดระบบใหม่ (`old_db_id` ว่าง) ไม่แตะ
  - ผูก exam 2 ทาง (`nurse_work.examination` + `examination.nurse_work`) กับ exam ที่ migrate มาของนัดนั้นตัวล่าสุด เฉพาะช่องที่ยังว่าง — exam ของนัดใหม่มาตอน step examination จึงผูกท้าย job นั้น
  - เวลานัดที่ migrate เปลี่ยน → sync `nurse_work.appointment_datetime` ตาม; สรุปอยู่ใน `bxNurseWork` ของ `logs/migrate-*.json`
  - ท้าย job examination: nurse_work ที่ migrate สร้างแล้วยังผูก exam ไม่ได้ (DB เก่าไม่มี exam ของนัด) → สร้าง exam แบบ flow `[id-87]` ให้ทุกตัว รวมนัดในอดีต — ตกลง 2026-11-25
    - exam ใหม่: `nurse_work`, `appointment`, `patient` = คนไข้ของนัด, `exam_date` = เวลานัด; `status` ไม่ตั้ง (flow ก็ไม่ตั้ง)
    - คนไข้มี exam ก่อนหน้า (`exam_date` ไม่เกินเวลานัด) → คัดลอกฟิลด์ประวัติตาม flow (`FLOW_ID87_COPY_FIELDS`) + `exam_reason_type` = `Special Procedure`
    - แยกจาก exam จริงด้วย `old_exam_id` / `date_created` / `user_created` ว่าง; `patient` / `exam_date` sync ตามนัดทุกรอบ (ทั้ง 2 job ก่อนลบคนไข้ K)
    - รอบถัดไป DB เก่ามี exam ของนัดนั้น → ลบ exam ที่สร้างแล้วผูก exam จริงแทน เฉพาะตัวที่ยังไม่ถูกแตะในระบบใหม่ (`date_updated` / `user_updated` ว่าง และไม่มีตารางอื่นอ้างถึง) — ถูกแตะแล้วคงไว้ exam จริงไม่ผูก
    - จำนวนแถวใน `public.examination` จะมากกว่าต้นทางเท่ากับ exam ที่สร้าง (`examCreated` ใน `bxNurseWork`)
