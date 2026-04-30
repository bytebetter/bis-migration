# JS migration — `procedure` (dbo.biopsy)

Flow เดียวกับ `appointment/js-migrate` และ `examination/js-migrate`:

- ดึงจาก MSSQL แบบแบ่ง chunk (OFFSET ตาม `[Exam_ID]`, `[BiopsyID]`)
- ใส่ staging (`migrate_stg.biopsy_mssql`)
- แมปเข้า `public."procedure"` ผ่าน `procedureMapping.mjs`
- รองรับ checkpoint + rollback ราย chunk

## ไฟล์สำคัญ

- `migrate-from-mssql.mjs` — entry
- `mssqlProcedureSelect.mjs` — SELECT `dbo.biopsy`
- `procedurePgDdl.mjs` — staging DDL
- `procedureMapping.mjs` — แมปฟิลด์ + join `Exam_ID` → `public.examination.id` (ผ่าน `old_exam_id`)
- `run-migrate.ps1` — runner
- Config ที่ root: `migration.config.local.json` (profile `procedure`)

## ข้อจำเป็นก่อนรัน

1. Migrate `examination` แล้ว — จะดึง `SELECT id, old_exam_id FROM public.examination` เพื่อแมป `exam`.
2. ถ้ายังไม่มีคอลัมน์ **`old_db_id`** บนปลายทาง (`varchar`) — สคริปต์จะ **`ALTER TABLE ... ADD COLUMN`** ให้อัตโนมัติในรัน และมีดัชนี partial เพื่อช่วย `DELETE ... WHERE old_db_id = ANY(...)`.


## Run

```powershell
cd .\procedure\js-migrate
npm install
npm run migrate
```

หรือ Task: **migrate: procedure (biopsy) → Postgres (js-migrate)** ใน `.vscode/tasks.json`

## หมายเหตุ

- ฟิลด์ `exam` (FK ไป `examination`) จะได้ค่าก็ต่อเมื่อมีแถว `old_exam_id` ตรงกับ `Exam_ID` จาก MSSQL; ถ้าไม่พบข้ามแถวนั้น
- `review_outside_study`, `state` (ค่าคง `"0"` ตามที่ Directusใช้อยู่) เป็นค่าตามแบบอย่างจาก Directus
- ฟิลด์ `recommend_milignant` (สะกดแบบ Directus เดิม) แมปจาก MSSQL `Recommend_Malignant`
- Log: `logs/migrate-*.json` · checkpoint: `checkpoints/procedure.json`
