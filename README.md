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

## รัน migrate ทุกตารางทีเดียว (`run-migrate-all.ps1`)

สคริปต์ที่ root รัน **ทีละตารางตามลำดับ** (รอตารางก่อนหน้าจบก่อนค่อยไปต่อ) ถ้าตารางใดล้มเหลวจะหยุดทันที

| ลำดับ | ตาราง |
|------|--------|
| 1 | `patient_info` |
| 2 | `appointment` |
| 3 | `examination` |
| 4 | `examination_general` |
| 5 | `pacs_sync_info` |
| 6 | `procedure` |
| 7 | `ultrasound` |
| 8 | `mammogram` |
| 9 | `mammogram_cal` |
| 10 | `mammogram_mass` |
| 11 | `ultrasound_cyst` |
| 12 | `ultrasound_mass` |

### ก่อนรัน

1. สร้าง `migration.config.local.json` จาก `migration.config.example.json` ที่ root
2. ติดตั้ง Node 20+ และ `npm` ใน PATH
3. เชื่อมต่อ MSSQL / PostgreSQL ตาม config (เช่น port-forward)

ครั้งแรกจะ `npm install` ที่ `patient-info/js-migrate` (ถ้ายังไม่มี `node_modules`) ตารางถัดไปข้าม install อัตโนมัติ

### คำสั่ง

จาก root โปรเจกต์:

```powershell
cd C:\path\to\BIS-DB-Migration

# รันทั้ง 12 ตาราง
.\run-migrate-all.ps1

# ข้าม npm install ทุกตาราง (รันซ้ำ / ติดตั้ง dependencies แล้ว)
.\run-migrate-all.ps1 -SkipInstall

# เริ่มจากตารางที่ 3 (examination) ถ้า 1–2 เสร็จแล้ว
.\run-migrate-all.ps1 -StartFrom 3 -SkipInstall
```

ถ้า PowerShell บล็อกสคริปต์:

```powershell
powershell -ExecutionPolicy Bypass -File .\run-migrate-all.ps1
```

### Log / ดูว่าถึงตารางไหน

| ไฟล์ | ความหมาย |
|------|-----------|
| `logs/run-migrate-all-YYYYMMDD-HHmmss.log` | บันทึกเริ่ม/สำเร็จ/ล้มเหลว ทุกขั้น |
| `logs/run-migrate-all.current.txt` | สถานะล่าสุด (เปิดดูได้ทันที) |

```powershell
# ดูสถานะปัจจุบัน
Get-Content .\logs\run-migrate-all.current.txt

# ติดตามแบบ realtime
Get-Content .\logs\run-migrate-all.current.txt -Wait
```

ตัวอย่างใน `current.txt` ขณะรัน: `RUNNING ; [3/12] examination ; 3/12`

### รันต่อหลังล้มเหลว

ดู log ว่าหยุดที่ขั้นที่เท่าไร แล้วใช้ `-StartFrom <เลขขั้น>` เช่น ล้มที่ `appointment` (ขั้น 2):

```powershell
.\run-migrate-all.ps1 -StartFrom 2 -SkipInstall
```

รัน migrate ทีละตารางแยกได้ตามเดิมที่ `<โฟลเดอร์>/js-migrate/run-migrate.ps1`

## โครงสร้าง

- **`patient-info/`** — migrate `patient_info` → [patient-info/README.md](patient-info/README.md)
- **`examination/`** — migrate `examination` → [examination/README.md](examination/README.md)
- **`appointment/`** — migrate `schedule` → `appointment` → [appointment/js-migrate/README.md](appointment/js-migrate/README.md)
- **`db-selective-migration/`** — clone schema + เลือกตาราง (Directus + whitelist) ผ่าน `kubectl` / `pg_dump` → [db-selective-migration/README.md](db-selective-migration/README.md) — ติดตั้ง Postgres บน server ด้วย Docker + restore: [db-selective-migration/docs/production-docker-restore.md](db-selective-migration/docs/production-docker-restore.md) — ไฟล์ SQL ตั้งต้นใน Git: [db-selective-migration/baseline/](db-selective-migration/baseline/)
- ตารางอื่นเพิ่มเป็นโฟลเดอร์ระดับเดียวกับ `patient-info/` ได้

## ความต้องการ

- Node 20+ สำหรับ `patient-info/js-migrate`, `examination/js-migrate`, `appointment/js-migrate`
- การ port-forward ไป Postgres หรือ network ตามสภาพแวดล้อม
