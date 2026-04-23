# Migrate `patient_info`: MSSQL → PostgreSQL

Flow หลักอยู่ที่ **`patient-info/js-migrate/`** — อ่านจาก MSSQL แบ่งแบทช์ สร้าง staging บน Postgres แล้วแมปเข้า `public.patient_info` และ `public.address` ด้วย **JavaScript** (`patientInfoMapping.mjs`) ไม่ต้องมีไฟล์ SQL แยกใน repo นี้อีกต่อไป

## โครงสร้าง

```
patient-info/
├── README.md              ← คู่มือนี้
├── imports/               ← (ทางเลือก) งานเก่าที่ใช้ CSV — ไม่บังคับสำหรับ js-migrate
└── js-migrate/
    ├── migrate-from-mssql.mjs   ← entry
    ├── patientInfoMapping.mjs   ← แมปฟิลด์ + insert ปลายทาง
    ├── patientInfoPgDdl.mjs     ← DDL staging + `norm_pid`
    ├── mssqlPatientInfoSelect.mjs ← SELECT จาก MSSQL
    └── run-migrate.ps1          ← one-click runner
```

## รัน

```powershell
cd .\patient-info\js-migrate
npm install
npm run migrate
```

หรือใช้ Task ใน VS Code/Cursor: **`migrate: patient_info → Postgres (js-migrate)`** (ดู `.vscode/tasks.json`)

ค่าเชื่อมต่อใช้ไฟล์กลางที่ root: `migration.config.local.json` (profile: `patient_info`)

## หมายเหตุ

- Logic แปลง (พ.ศ. → ค.ศ., ที่อยู่ ฯลฯ) อยู่ใน `patientInfoMapping.mjs` — แก้/ขยายได้ที่นี่
- ถ้าต้องการล้างฐาน clone ก่อนรันใหม่ ให้รัน `TRUNCATE` ฝั่ง Postgres เอง (สคริปต์ไม่ล้าง `public` ให้แล้ว)
- ถ้าต้องการตารางอื่นนอก `patient_info` ให้เพิ่ม `tables[]` และจัด `selectSqlFile` + staging เอง (ดู `js-migrate/README.md`)
