# DB Compare Utility

เครื่องมือนี้ใช้เปรียบเทียบข้อมูลระหว่าง:

- MSSQL ฝั่งลูกค้า (`source` จาก config)
- PostgreSQL ฝั่งเรา (`target` จาก config)

รองรับการระบุ `ชื่อตาราง` และ `length` (จำนวนแถวตัวอย่าง) จากคำสั่ง CMD/PowerShell

## ใช้งานเร็ว

จาก root โปรเจกต์:

```powershell
.\compare-table.ps1 -Table "dbo.patient_info" -Length 2000
```

## พารามิเตอร์หลัก

- `-Table` (จำเป็น): ชื่อตาราง เช่น `dbo.examination`
- `-Length`: จำนวนแถวตัวอย่างที่ใช้เทียบ (default = 1000)
- `-Profile`: โปรไฟล์ใน config (default = `patient_info`)
- `-ConfigPath`: ไฟล์ config (default = `.\migration.config.local.json`)
- `-OrderBy`: ระบุคอลัมน์เรียงก่อนเทียบตัวอย่าง เช่น `Exam_ID` หรือ `Exam_ID,PID`
- `-KeyColumn`: คีย์สำหรับเทียบแบบตัวต่อตัว (`id ต่อ id`) ถ้าไม่ระบุจะใช้ตัวแรกจาก `-OrderBy` หรือ `id`
- `-MssqlKeyColumn`: ระบุคีย์ฝั่ง MSSQL โดยเฉพาะ (เช่น `pid`)
- `-PgKeyColumn`: ระบุคีย์ฝั่ง Postgres โดยเฉพาะ (เช่น `old_db_id`)
- `-KeyStart` / `-KeyEnd`: ระบุช่วงคีย์ที่จะดึงมาเทียบ (เช่น `pid 2000-2500`) แทนการไล่จากต้นตาราง
- `-MaxDiffRows`: จำนวนแถว diff ที่เก็บลงรายงานสูงสุด (default = 200)
- `-NoSample`: ปิดการเทียบตัวอย่างแถว (จะเทียบเฉพาะ count/column)

## ตัวอย่าง

```powershell
.\compare-table.ps1 -Table "dbo.examination" -Length 5000 -Profile examination -OrderBy "Exam_ID"
```

เทียบแบบ field ต่อ field โดยคีย์:

```powershell
.\compare-table.ps1 -Table "dbo.patient_info" -Length 2000 -OrderBy "pid" -KeyColumn "pid"
```

เทียบคีย์คนละชื่อ (`mssql.pid = postgres.old_db_id`):

```powershell
.\compare-table.ps1 -Table "dbo.patient_info" -Length 2000 -OrderBy "pid" -MssqlKeyColumn "pid" -PgKeyColumn "old_db_id"
```

เทียบเฉพาะช่วง `pid` (ไม่ใช่ 2000 ตัวแรก):

```powershell
.\compare-table.ps1 -Table "dbo.patient_info" -Length 2000 -OrderBy "pid" -KeyColumn "pid" -KeyStart "2000" -KeyEnd "2500"
```

เทียบเฉพาะจำนวนแถวและโครงสร้างคอลัมน์:

```powershell
.\compare-table.ps1 -Table "dbo.procedure" -NoSample
```

## ผลลัพธ์

สคริปต์จะพิมพ์สรุปใน console และบันทึกไฟล์รายงาน JSON ใน:

- `compare-reports/<schema>.<table>.<timestamp>.json`

รายงานประกอบด้วย:

- จำนวนแถวทั้งหมดของ MSSQL/Postgres
- ส่วนต่างจำนวนแถว
- คอลัมน์ที่มีเฉพาะฝั่งใดฝั่งหนึ่ง
- ผล overlap ของข้อมูลตัวอย่างตาม `length`
- ผลเทียบแบบตัวต่อตัวตามคีย์ (`keyMatchedComparison`) พร้อม field ที่ต่างกัน
- ค่า filter ช่วงคีย์ใน `options.keyRange` (ถ้ามีการกำหนด)


.\compare-table.ps1 -Table "dbo.patient_info" -Length 2000 -OrderBy "pid" -MssqlKeyColumn "pid" -PgKeyColumn "old_db_id" -KeyStart "2000" -KeyEnd "2500"