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

### ลำดับ CreatedDate และ checkpoint (resume รายวัน)

- เรียง MSSQL ด้วย **sort key**: `CreatedDate` เป็น NULL ก่อน (ข้อมูลเก่า) แล้วตามวันที่สร้างจากเก่า→ใหม่ ใช้ PID เป็น tiebreaker
- **INSERT** แถวใหม่ → `date_created = now()` (เวลาที่ migrate ลง Postgres ไม่ใช่ค่าจาก MSSQL)
- คนไข้ใหม่ที่มี `CreatedDate` อยู่ท้ายลำดับ — resume ดึงต่อจาก `mssqlKeysetAfter` ใน checkpoint
- ใช้ **keyset** (`sort_key > checkpoint`) แทน OFFSET — ไม่พลาดแถวใหม่ท้ายตารางเมื่อรัน resume รายวัน
- **Postgres ว่าง** → migrate จากต้น (keyset เต็มแถว/chunk, ปิด id probe) รีเซ็ต checkpoint
- **ต่อ checkpoint ไม่จบ** (`completed: false`) → keyset ต่อท้าย ~แถวที่เหลือ, **ปิด id probe**
- **daily sync** (ค่าเริ่มต้นเปิด, `patientInfoDailySync`) หลัง `completed: true` + โหมด resume:
  - **ไม่ข้าม job** แม้ fingerprint MSSQL เท่าเดิม — probe ท้ายตารางเสมอ (เร็วถ้าไม่มีแถวใหม่)
  - **catch-up**: ถ้า MSSQL เพิ่มแถว หรือ Postgres ขาดกว่า COUNT (ไม่นับ placeholder) → สแกนตั้งแต่ต้นด้วย id probe เติม PID ที่ขาด (รวมแถวใหม่ `CreatedDate` NULL ที่ไม่อยู่ท้าย)
  - **tail upsert**: ถ้า `maxSortKey` ใหม่กว่า checkpoint → ดึงแถวท้ายแล้ว **upsert** (อัปเดตชื่อ/ที่อยู่แถวที่ดึง)
- checkpoint เก็บ `offset`, `mssqlKeysetAfter`, `sortKeyVersion` (v2 = CreatedDate), `sourceRowCount`, `sourceMaxSortKey`
- config: `patientInfoDailySync` (default `true`), `patientInfoSmartResume` (legacy — `false` ปิด daily sync)

### โหมดรัน (`migrateRunMode` / `-MigrateRunMode`)

| โหมด                       | พฤติกรรม `patient_info`                                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **resume** (`insert-only`) | รายวัน: เติม PID ที่ขาด + upsert ท้ายตารางเมื่อ `CreatedDate` ใหม่; ไม่ทับแถวจริงเดิมนอกช่วงที่ดึง; placeholder `ไม่ทราบชื่อ` ยังคงไว้ |
| **overwrite**              | PID ที่มีแล้ว → **UPDATE** ตาม `patient_info.id` (คง `id` เดิม) แล้วลบ/ใส่ `address` ใหม่; PID ใหม่ → INSERT                                                                                                                      |
| **repair-from-log**        | เหมือน overwrite แต่ดึงเฉพาะ PID จาก log ล่าสุด — จบแล้วแสดงจำนวนจาก log / สำเร็จ / ไม่สำเร็จ                                                                                                                                     |

```powershell
npm run migrate:patient_info -- --migrate-run-mode overwrite
.\patient-info\js-migrate\run-migrate.ps1 -MigrateRunMode overwrite -SkipInstall
```
