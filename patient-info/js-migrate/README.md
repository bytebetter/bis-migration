# JS Migration (New Flow)

โฟลเดอร์นี้เป็น flow ใหม่แบบ JS ตามที่ต้องการ โดยไม่แก้ไฟล์ flow เดิม

## Checklist

- [x] แยกโฟลเดอร์ใหม่สำหรับ JS migration
- [x] เปลี่ยน source จาก CSV เป็น MSSQL URL
- [x] กำหนดปลายทางเป็น `bisinfo_dev_clone`
- [x] แยกค่า server/database ไว้ใน config file
- [x] รองรับหลายตารางด้วย `tables[]` ใน config
- [ ] เติมรหัสผ่าน Postgres ใน `config.local.json`
- [ ] เปิด `kubectl port-forward` ไป Postgres ใน k8s
- [ ] รัน migration และตรวจผล

## Setup

```powershell
cd .\patient-info\js-migrate
npm install
```

## Config

1. ใช้ `config.local.json` สำหรับเครื่อง local (ไฟล์นี้ถูก ignore แล้ว)
2. ถ้าต้องการตัวอย่างสะอาด ใช้ `config.example.json`
3. ใส่ค่า `target.postgresPassword` ให้ถูกต้อง
4. `source` รองรับ 2 แบบ:
   - `mssqlUrl`
   - แยกรายละเอียด: `server`, `port`, `database`, `user`, `password`
5. กำหนดหลายตารางที่ `tables[]` โดยแต่ละตารางต้องมี:
   - `sourceSchema`, `sourceTable`, `orderBy`
   - `stagingTable`, `columns`
   - `selectSqlFile`
   - `preLoadSqlFiles`, `postLoadSqlFiles`, `truncateSqlFiles`

## เพิ่มตารางใหม่

1. สร้างไฟล์ select ของตารางใหม่ที่ `patient-info/js-migrate/sql/*.select.sql`
2. เพิ่ม object ใหม่ใน `tables[]` ของ `config.local.json`
3. เตรียม SQL staging/insert/truncate ของตารางนั้นไว้ใน `patient-info/sql/`
4. รัน `npm run migrate` (สคริปต์จะวิ่งทุกตารางตามลำดับใน `tables[]`)

## Run

```powershell
cd .\patient-info\js-migrate
npm run migrate
```

หรือกดปุ่ม **Run Code** ที่ไฟล์ `run-migrate.ps1` ได้เลย

```powershell
cd .\patient-info\js-migrate
.\run-migrate.ps1
```

## หมายเหตุ

- สคริปต์อ่าน SQL mapping เดิมจาก `patient-info/sql/` เพื่อให้ logic แปลงข้อมูลเหมือน flow เดิม
- source query ตอนนี้อ่านจาก `dbo.patient_info` ตามโครงเดิม
- ค่าเริ่มต้นจะรัน post-load 2 ขั้น: `02_insert_into_clone_patient_info.sql` และ `03_insert_addresses_from_staging.sql` เพื่อผูก `address` relation ให้อัตโนมัติ
- โหมดปัจจุบันเป็น **chunk + checkpoint + idempotent upsert**
- ถ้า chunk ใด fail จะ rollback เฉพาะ chunk นั้น และสามารถ resume ต่อจาก checkpoint ได้
- มีไฟล์ log ที่ `patient-info/js-migrate/logs/migrate-*.json` ระบุ success/fail cases และรายการ `failedPids` (สูงสุด 200 รายการ)
- checkpoint อยู่ที่ `patient-info/js-migrate/checkpoints/*.json` (กำหนดได้ด้วย `migration.checkpointDir`)
