# DB Export Utility

โฟลเดอร์นี้เป็นเครื่องมือ **export ข้อมูลจาก MSSQL ออกมาเป็นไฟล์ JSON**

## จุดประสงค์

- ดึงข้อมูลจากตารางที่ระบุ (`schema.table`)
- เก็บผลเป็นไฟล์ JSON ในโฟลเดอร์ `exports/`
- ใช้สำหรับ **review / ตรวจข้อมูลก่อน** แล้วค่อยนำไปทำ migration ต่อ

> สคริปต์นี้ **ไม่ทำการ migrate** และ **ไม่เขียนข้อมูลเข้า Postgres ปลายทาง**

## ไฟล์หลัก

- `export-table.mjs` — ตัว export ข้อมูล
- เรียกใช้งานผ่านสคริปต์รากโปรเจกต์ `dump-table.ps1`

## วิธีใช้

จากรากโปรเจกต์:

```powershell
.\dump-table.ps1 -Table "dbo.examination" -Limit 4000
```

export ทั้งตาราง:

```powershell
.\dump-table.ps1 -Table "dbo.examination" -All
```

ปรับขนาดหน้าต่อรอบ (มีผลกับความถี่ progress และ memory):

```powershell
.\dump-table.ps1 -Table "dbo.examination" -All -PageSize 1000
```

ถ้าไม่ใส่ `-PageSize` จะใช้ค่า `migration.batchSize` ของ profile ใน config โดยอัตโนมัติ

ระบุชื่อไฟล์ output เอง:

```powershell
.\dump-table.ps1 -Table "dbo.patient_info" -Limit 2000 -Out ".\exports\patient_info.sample.json"
```

## Output ที่ได้

ไฟล์ JSON จะมีโครงหลักแบบนี้:

- `exportedAt` เวลาที่ export
- `source` ข้อมูลต้นทาง (server/database/table)
- `limit` จำนวนสูงสุดที่ขอ
- `all` ว่าเป็นโหมด export ทั้งตารางหรือไม่
- `rowCount` จำนวนที่ดึงได้จริง
- `elapsedMs` เวลา query
- `rows` ข้อมูลแถวทั้งหมดที่ export

ระหว่าง export จะมี progress bar ใน CLI แสดง `%`, แถวที่ดึงแล้ว และเวลาที่ใช้

สคริปต์จะเขียนไฟล์แบบเป็นช่วงๆ (stream write) เพื่อลดการใช้ RAM ตอน export ตารางใหญ่

## หลังจาก export แล้ว

1. เปิดไฟล์ใน `exports/` เพื่อตรวจสอบข้อมูล
2. ค่อยรันสคริปต์ migration (คนละขั้นตอนกับ export)

คำสั่ง 
.\dump-table.ps1 -Table "dbo.ชื่อtable" -All 

.\examination\js-migrate\run-migrate.ps1