# JS migration — `patient_info`

## ไฟล์สำคัญ

| ไฟล์ | บทบาท |
|------|--------|
| `migrate-from-mssql.mjs` | อ่าน config, ดึง MSSQL แบทช์, ลง staging, เรียกแมป |
| `mssqlPatientInfoSelect.mjs` | สตริง `SELECT` จาก `dbo.patient_info` (แทน `.sql` เดิม) |
| `patientInfoPgDdl.mjs` | สร้าง `migrate_stg` + ตาราง staging + ฟังก์ชัน `norm_pid` |
| `patientInfoMapping.mjs` | แมป `staging → public.patient_info` + `public.address` (แทน `02_` / `03_` SQL เดิม) |

## Checklist

- [ ] คัดลอก `migration.config.example.json` → `migration.config.local.json` (ที่ root repo) แล้วใส่รหัส
- [ ] เปิด `kubectl port-forward` หรือ network ไปยัง Postgres ปลายทาง
- [ ] รัน `npm install` ในโฟลเดอร์นี้

## Config

- ใช้ config กลางที่ root: `migration.config.local.json`
- ระบุ profile `patient_info` ผ่าน `--profile patient_info`
- `source`: MSSQL แบบ `mssqlUrl` หรือ `server` / `port` / `database` / `user` / `password`
- ถ้าเจอ `ETIMEOUT` 15s: ตั้ง `source.requestTimeout` (มิลลิวินาที) ใน `migration.config.local.json` หรือใช้ค่า default ในโค้ด (5 นาที) หลังอัปเดต
- `target`: Postgres สำหรับ `bisinfo_dev_clone` (หรือฐานที่กำหนด)

### ตารางใหม่ (ยังไม่มี built-in)

1. สร้าง `your_table.select.sql` แล้วอ้างใน `selectSqlFile` ( path สัมพัทธ์จากโฟลเดอร์ `js-migrate/`)
2. ใส่ `preLoadSqlFiles` / `postLoadSqlFiles` ตามต้องการ (ล้างตารางปลายทางเองก่อนรันหากจำเป็น)
3. หรือ implement โมดูล JS แยก แล้ว wire ที่ `migrate-from-mssql.mjs` แนว `patientInfoMapping.mjs`

## Run

```powershell
cd .\patient-info\js-migrate
npm run migrate
```

Log: `logs/migrate-*.json` — checkpoint: `checkpoints/<key>.json`
