# Migrate `examination`: MSSQL -> PostgreSQL

Flow หลักอยู่ที่ **`examination/js-migrate/`** — อ่านจาก MSSQL แบ่งแบทช์ สร้าง staging บน Postgres แล้วแมปเข้า `public.examination` ด้วย JavaScript (`examinationMapping.mjs`) ไม่ใช้ไฟล์ SQL migration แยกใน repo แล้ว

## โครงสร้าง

```
examination/
├── README.md              ← คู่มือนี้
├── imports/               ← (ทางเลือก) ไฟล์นำเข้าเก่า
├── reports/               ← เก็บรายงานประกอบ (ถ้ามี)
└── js-migrate/
    ├── migrate-from-mssql.mjs      ← entry
    ├── examinationMapping.mjs      ← แมปฟิลด์ + insert ปลายทาง
    ├── examinationPgDdl.mjs        ← DDL staging + `norm_exam_id` + `norm_pid`
    ├── mssqlExaminationSelect.mjs  ← SELECT จาก MSSQL
    ├── run-migrate.ps1             ← one-click runner
```

## รัน

```powershell
cd .\examination\js-migrate
npm install
npm run migrate
```

หรือใช้ Task ใน VS Code/Cursor: **`migrate: examination → Postgres (js-migrate)`** (ดู `.vscode/tasks.json`)

ค่าเชื่อมต่อใช้ไฟล์กลางที่ root: `migration.config.local.json` (profile: `examination`)

## หมายเหตุ

- Logic แปลงข้อมูลอยู่ใน `examinationMapping.mjs`
- สคริปต์ไม่ล้าง `public.examination` อัตโนมัติ
- ถ้าต้องการล้างฐาน clone ก่อนรันใหม่ ให้รัน `TRUNCATE` ฝั่ง Postgres เอง
