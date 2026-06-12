# JS migration — `patient_info`

## ไฟล์สำคัญ

| ไฟล์                         | บทบาท                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `migrate-from-mssql.mjs`     | อ่าน config, ดึง MSSQL แบทช์, ลง staging, เรียกแมป                                  |
| `mssqlPatientInfoSelect.mjs` | สตริง `SELECT` จาก `dbo.patient_info` (แทน `.sql` เดิม)                             |
| `patientInfoPgDdl.mjs`       | สร้าง `migrate_stg` + ตาราง staging + ฟังก์ชัน `norm_pid`                           |
| `patientInfoMapping.mjs`     | แมป `staging → public.patient_info` + `public.address` (แทน `02_` / `03_` SQL เดิม) |

## Checklist

- [ ] คัดลอก `migration.config.example.json` → `migration.config.local.json` (ที่ root repo) แล้วใส่รหัส
- [ ] เปิด `kubectl port-forward` หรือ network ไปยัง Postgres ปลายทาง
- [ ] ที่ **root repo** รัน `npm install` ครั้งหนึ่ง (หรือให้ `run-migrate.ps1` ติดตั้งให้อัตโนมัติ)

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

ทุกอย่างรันจาก **root ของ repo** เท่านั้น (`package.json` / `node_modules` มีแค่ที่ root — ไม่มีใต้ `*/js-migrate`):

```powershell
cd <root ของ repo>
npm install
npm run migrate:patient_info
```

หรือใช้ `.\patient-info\js-migrate\run-migrate.ps1` (โหลดแพ็กเกจจาก root โดยอัตโนมัติ)

Log: `logs/migrate-*.json` — checkpoint: `checkpoints/<key>.json`

### ลำดับ CreatedDate และ checkpoint (resume)

- เรียง MSSQL ด้วย **sort key**: `CreatedDate` เป็น NULL ก่อน (ข้อมูลเก่า) แล้วตามวันที่สร้างจากเก่า→ใหม่ ใช้ PID เป็น tiebreaker
- คนไข้ใหม่หลังเพิ่มฟิลด์ `CreatedDate` จะมีวันที่สร้างติดมา — แถวใหม่จึงอยู่ท้ายลำดับเสมอ ไม่แทรกกลาง checkpoint
- ใช้ **keyset** (`sort_key > checkpoint`) แทน OFFSET — ไม่พลาดแถวใหม่เมื่อรัน resume รายวัน
- **Postgres ว่าง** → migrate จากต้น (keyset เต็มแถว/chunk, ปิด id probe) รีเซ็ต checkpoint
- **ต่อ checkpoint ไม่จบ** (`completed: false`, มี `offset`/`mssqlKeysetAfter`) → keyset ต่อท้าย ~แถวที่เหลือ, **ปิด id probe**, progress แสดง `210000/214944` ไม่ใช่เริ่ม `0/214944`
- **มีข้อมูล + checkpoint แล้ว** → ค่าเริ่มต้น **keyset ต่อท้าย** (วิธีเดิม เร็ว)
- **smart resume** (ค่าเริ่มต้นเปิด): **ข้าม** เมื่อ fingerprint ต้นทางไม่เปลี่ยน มิฉะนั้น **keyset ต่อท้าย** (แถวใหม่อยู่ท้ายลำดับเสมอเพราะเรียง CreatedDate)
- checkpoint เก็บ `offset`, `mssqlKeysetAfter`, `sortKeyVersion` (v2 = CreatedDate), `sourceRowCount`, `sourceMaxSortKey`
- อัปเกรดจาก checkpoint เก่า (เรียง PID) → รีเซ็ต keyset แล้วสแกนต่อด้วย id probe (insert-only ข้ามที่มีใน Postgres)
- config: `patientInfoSmartResume` (default true)

### โหมดรัน (`migrateRunMode` / `-MigrateRunMode`)

| โหมด                       | พฤติกรรม `patient_info`                                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **resume** (`insert-only`) | เพิ่มเฉพาะ PID ที่ยังไม่มีใน Postgres — **ไม่แตะ**แถวจริงเดิม; แถว placeholder `ไม่ทราบชื่อ` จาก appointment/ตารางอื่น **ยังคงไว้** และยัง INSERT แถวจาก MSSQL ได้ (รวมแล้วได้ 1,010 + 200 = 1,210 ตามตัวอย่าง checkpoint รายวัน) |
| **overwrite**              | PID ที่มีแล้ว → **UPDATE** ตาม `patient_info.id` (คง `id` เดิม) แล้วลบ/ใส่ `address` ใหม่; PID ใหม่ → INSERT                                                                                                                      |
| **repair-from-log**        | เหมือน overwrite แต่ดึงเฉพาะ PID จาก log ล่าสุด — จบแล้วแสดงจำนวนจาก log / สำเร็จ / ไม่สำเร็จ                                                                                                                                     |

```powershell
npm run migrate:patient_info -- --migrate-run-mode overwrite
.\patient-info\js-migrate\run-migrate.ps1 -MigrateRunMode overwrite -SkipInstall
```
