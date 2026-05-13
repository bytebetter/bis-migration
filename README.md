# BIS-DB-Migration

เครื่องมือย้ายข้อมูล MSSQL / CSV → PostgreSQL (Directus) — แยกจาก front-end **BIS-Backoffice**

## เมื่อได้ลิงก์ repo จากหัวหน้า

```powershell
cd $HOME\Documents   # หรือโฟลเดอร์ที่ทีมกำหนด
git clone <url> BIS-DB-Migration
cd BIS-DB-Migration\patient-info\js-migrate
npm install
cd ..\..\examination\js-migrate
npm install
cd ..\..\appointment\js-migrate
npm install
```

เปิดโฟลเดอร์นี้เป็น workspace ใน Cursor/VS Code จะใช้ **Tasks** ใน `.vscode/tasks.json` รันได้ `patient-info`, `examination`, `appointment`

ตั้งค่าเชื่อมต่อจากไฟล์กลางที่ root:
- `migration.config.example.json` (template)
- `migration.config.local.json` (ใช้งานจริง, แยกตาม profile)

## โครงสร้าง

- **`patient-info/`** — migrate `patient_info` → [patient-info/README.md](patient-info/README.md)
- **`examination/`** — migrate `examination` → [examination/README.md](examination/README.md)
- **`appointment/`** — migrate `schedule` → `appointment` → [appointment/js-migrate/README.md](appointment/js-migrate/README.md)
- **`db-selective-migration/`** — clone schema + เลือกตาราง (Directus + whitelist) ผ่าน `kubectl` / `pg_dump` → [db-selective-migration/README.md](db-selective-migration/README.md) — ติดตั้ง Postgres บน server ด้วย Docker + restore: [db-selective-migration/docs/production-docker-restore.md](db-selective-migration/docs/production-docker-restore.md)
- ตารางอื่นเพิ่มเป็นโฟลเดอร์ระดับเดียวกับ `patient-info/` ได้

## ความต้องการ

- Node 20+ สำหรับ `patient-info/js-migrate`, `examination/js-migrate`, `appointment/js-migrate`
- การ port-forward ไป Postgres หรือ network ตามสภาพแวดล้อม
