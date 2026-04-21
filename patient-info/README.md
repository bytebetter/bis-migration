# Migrate `patient_info`: MSSQL → Postgres (`bisinfo_dev_clone`)

สคริปต์อยู่ในโฟลเดอร์นี้ของ repo นี้:

```
patient-info/
├── README.md                 ← คู่มือนี้
├── run-migrate-clone.ps1    ← รันครบ 01 → COPY → 02 → 03 → 04 ในครั้งเดียว (Windows / kubectl)
├── imports/                  ← วางไฟล์ CSV ที่ export จาก MSSQL (ไม่ commit ไฟล์จริง)
│   └── .gitkeep
├── tools/                    ← แบบไม่ใช้ CSV: อ่าน MSSQL ตรง → Postgres (ดูด้านล่าง)
│   ├── package.json
│   └── migrate-stream.mjs
└── sql/
    ├── 00_truncate_clone_patient_info.sql   ← ล้างตารางก่อนรันทดสอบซ้ำ (clone เท่านั้น)
    ├── 01_create_staging.sql                  ← สร้าง schema + ตาราง staging
    ├── 02_insert_into_clone_patient_info.sql← แปลง พ.ศ.→ค.ศ. แล้ว insert เข้า public.patient_info
    ├── 03_insert_addresses_from_staging.sql ← ลบ address เดิมของชุด migrate + sync id → insert ที่อยู่
    ├── 04_verify_clone.sql                  ← ตรวจจำนวนแถว/ตัวอย่าง
    └── export-from-mssql-patient_info.sql   ← รันฝั่ง MSSQL เพื่อ export ให้ลำดับคอลัมน์ตรงกับ staging
```

## หลักการ

- PK ระบบเก่า = `PID` → ใส่ใน `pid` และ `old_db_id` (ข้อความเดียวกัน) — ใช้ฟังก์ชัน `migrate_stg.norm_pid()` จับคู่ก่อนลบ/insert กันค่าไม่ตรง (BOM ใน CSV, ช่องว่าง) และ `DISTINCT ON` กัน staging ซ้ำ pid — **รัน migrate ซ้ำจำนวนแถวไม่ควรคูณสอง**
- วันเกิดใน MSSQL เป็น **พ.ศ.** → เก็บดิบใน staging แล้วแปลงเป็น **ค.ศ.** ตอน insert (`ปี - 543`)
- ที่อยู่จาก staging ไปยัง **ตาราง Directus `public.address`** (ลูกของ `patient_info`) ผ่าน `sql/03_*.sql` — ก่อน insert จะ **ลบ address เดิมของ patient ที่อยู่ใน staging ชุดนี้** แล้ว **sync sequence `id`** ให้ต่อเนื่อง จากนั้นค่อย insert ใหม่ — แมป: `Address`→`address`, `SubArea`→`sub_district`, `Area`→`district`, `Province`→`province`, `Zip`→`zipcode`, `Address2`→`address2` ถ้า error ชื่อตารางไม่ตรง ให้แก้ใน `03_insert_addresses_from_staging.sql` ให้ตรงกับฐานจริง (บางโปรเจกต์ใช้ชื่ออื่นแทน `address`)

## แบบอัตโนมัติโดยไม่ต้องวาง CSV ใน `imports/` (แนะนำ)

เครื่องคุณต้อง**ต่อได้ทั้ง MSSQL และ Postgres** (Postgres มักใช้ `kubectl port-forward` มาที่ `127.0.0.1:5432`)

1. ติดตั้ง dependency เฉพาะโฟลเดอร์นี้:

```powershell
cd .\patient-info\tools
npm install
```

2. ตั้งตัวแปร (ตัวอย่าง) แล้วรัน:

```powershell
$env:MSSQL_SERVER="your-sql-host"
$env:MSSQL_DATABASE="YourLegacyDb"
$env:MSSQL_USER="..."
$env:MSSQL_PASSWORD="..."
$env:MSSQL_TRUST_CERT="true"

$env:POSTGRES_HOST="127.0.0.1"
$env:POSTGRES_PORT="5432"
$env:POSTGRES_USER="devuser"
$env:POSTGRES_PASSWORD="..."
$env:POSTGRES_DATABASE="bisinfo_dev_clone"

# ถ้าต้องการล้าง public.patient_info ใน clone ก่อนรันทดสอบซ้ำ
# $env:TRUNCATE_PATIENT_FIRST="true"

npm run migrate
```

สคริปต์ `tools/migrate-stream.mjs` จะ: สร้าง staging ตาม `sql/01_*.sql` → ดึง `dbo.patient_info` แบบแบ่งหน้า → ใส่ staging → รัน `sql/02_*.sql` แล้ว `sql/03_*.sql`

ถ้า schema/ชื่อคอลัมน์ใน MSSQL ของคุณไม่ตรงกับในสคริปต์ แก้ query ใน `migrate-stream.mjs` ให้ตรงกับฐานเก่า (ลำดับคอลัมน์ใน PG ต้องตรงกับ `01_create_staging.sql`)

## รันแบบอัตโนมัติ (หลังมี CSV แล้ว)

จากราก repo `BIS-DB-Migration`:

```powershell
.\patient-info\run-migrate-clone.ps1 -CsvPath .\patient-info\imports\patient_info.csv
```

ถ้าต้องการ **ล้าง `public.patient_info` ใน clone ก่อน** (รอบทดสอบ):

```powershell
.\patient-info\run-migrate-clone.ps1 -CsvPath .\patient-info\imports\patient_info.csv -TruncateFirst
```

ถ้าไม่ใส่ `-CsvPath` จะใช้ไฟล์ **`imports/patient_info.csv`** ข้างสคริปต์โดยอัตโนมัติ

**รันซ้ำได้ (ลด dup PID):** ไฟล์ `sql/02_*.sql` จะ **`DELETE`** แถวใน `public.patient_info` ที่ `pid` ตรงกับชุดใน staging ก่อน แล้ว **`setval` sequence** ให้ `id` ต่อจาก `MAX(id)` ที่เหลือ (ตารางว่างจะได้เริ่มที่ **1**) แล้วค่อย `INSERT` — กดรันซ้ำแล้วไม่ควรซ้ำ PID (ถ้า `DELETE` โดน FK บล็อก ให้ใช้ `-TruncateFirst` / CASCADE ตามเดิม)

**ถ้ามี patient คนอื่นอยู่ในตารางอยู่แล้ว:** `id` ชุด import จะต่อจาก **เลข max เดิม** ไม่ได้รีเซ็ตเป็น 1 (ปกติของ DB ที่ยังมีแถวอื่น) — อยากได้เฉพาะ 1..N จริงๆ ต้องฐานว่างหรือใช้ `TRUNCATE` / ฐาน clone ใหม่

### รันจาก Cursor / VS Code (ไม่ต้องพิมพ์คำสั่ง)

1. กด **Ctrl+Shift+P** (หรือ F1) → พิมพ์ **Tasks: Run Task**
2. เลือกอย่างใดอย่างหนึ่ง:
   - **`migrate: patient_info → bisinfo_dev_clone (CSV ค่าเริ่มต้น)`** — import ตาม CSV
   - **`migrate: patient_info (ล้าง clone TRUNCATE CASCADE ก่อน)`** — ล้างก่อนแล้ว import (ระวัง CASCADE กวาดตารางที่ FK มาที่ `patient_info`)

โปรเจกต์มีไฟล์ `.vscode/tasks.json` เป็นตัวรัน `run-migrate-clone.ps1` ให้แล้ว

**หมายเหตุ:** ปุ่ม **Run Code** ของ extension บางตัวอาจไม่ได้ใช้ PowerShell กับไฟล์ `.ps1` — ใช้ **Run Task** หรือเปิดเทอร์มินัล PowerShell แล้วรันสคริปต์จะชัวร์กว่า

**ถ้าเคยเจอ `ERROR: unquoted carriage return found in data` ตอน COPY:** มักเกิดจากการ pipe CSV จาก PowerShell ไป `psql` บน Windows ที่แทรก `\r` เข้า stream — สคริปต์ `run-migrate-clone.ps1` รุ่นปัจจุบันใช้ **`kubectl cp` ขึ้น pod แล้ว `\copy` จากไฟล์ใน pod** แทน ไม่ต้องแก้ CSV เอง

**ถ้าเจอ `kubectl cp failed` / `one of src or dest must be a local file specification` บน Windows:** ค่าเริ่มต้นของ `kubectl cp` บางเวอร์ชันไม่ยอมรับ path แบบ `C:\...` เป็นฝั่ง local — สคริปต์จะ **`cd` ไปที่โฟลเดอร์ของ CSV แล้วใช้ path แบบ `./ชื่อไฟล์`** ก่อนเรียก `kubectl cp`

## ขั้นตอนแบบย่อ (ทำมือทีละคำสั่ง)

1. **Export จาก MSSQL**  
   เปิด `sql/export-from-mssql-patient_info.sql` แก้ `FROM dbo.patient_info` ถ้า schema ไม่ใช่ `dbo`  
   บันทึกผลเป็น **CSV UTF-8** มีหัวคอลัมน์  
   วางไฟล์ที่ `patient-info/imports/` เช่น `patient_info.csv`

2. **(ทางเลือก) ล้างตารางใน clone ก่อนรันซ้ำ**  
   เชื่อมต่อ `bisinfo_dev_clone` แล้วรัน `sql/00_truncate_clone_patient_info.sql`  
   ใช้เฉพาะ clone — **ห้ามรันกับ bisinfo_dev โดยไม่ตั้งใจ**

3. **สร้าง staging**  
   Pipe ไฟล์เข้า `psql` (ตัวอย่างใช้ pod Postgres ใน k8s):

   ```powershell
   $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
   Get-Content .\patient-info\sql\01_create_staging.sql -Raw | kubectl -n default exec -i postgresql-0 -- psql -U devuser -d bisinfo_dev_clone
   ```

4. **โหลด CSV เข้า staging**  
   ลำดับคอลัมน์ใน CSV ต้องตรงกับตาราง staging (ตรงกับ SELECT ใน export-from-mssql)

   ```powershell
   Get-Content .\patient-info\imports\patient_info.csv -Raw | kubectl -n default exec -i postgresql-0 -- psql -U devuser -d bisinfo_dev_clone -c "COPY migrate_stg.patient_info_mssql FROM STDIN WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');"
   ```

   ถ้า encoding ผิด ให้บันทึก CSV เป็น UTF-8 จาก SSMS หรือแปลงไฟล์ก่อน

5. **Insert เข้า `public.patient_info`**

   ```powershell
   Get-Content .\patient-info\sql\02_insert_into_clone_patient_info.sql -Raw | kubectl -n default exec -i postgresql-0 -- psql -U devuser -d bisinfo_dev_clone
   ```

6. **Insert ที่อยู่เข้า `public.address` (Directus)**

   ```powershell
   Get-Content .\patient-info\sql\03_insert_addresses_from_staging.sql -Raw | kubectl -n default exec -i postgresql-0 -- psql -U devuser -d bisinfo_dev_clone
   ```

7. **Verify**

   ```powershell
   Get-Content .\patient-info\sql\04_verify_clone.sql -Raw | kubectl -n default exec -i postgresql-0 -- psql -U devuser -d bisinfo_dev_clone
   ```

## เทียบกับ `bisinfo_dev`

PostgreSQL ไม่ join ข้าม database ใน query เดียวได้โดยตรง ถ้าไม่ติดตั้ง extension (เช่น `dblink`)  
แนะนำแยกรัน:

- `\c bisinfo_dev_clone` → `SELECT count(*) FROM public.patient_info;`
- `\c bisinfo_dev` → `SELECT count(*) FROM public.patient_info;`

หรือ export รายการ `pid` / `old_db_id` จากทั้งสองฐานแล้ว diff ด้วยเครื่องมือภายนอก

## Credential

ถ้ารันจากเครื่อง local ด้วย `psql` + `kubectl port-forward` ให้ใช้ user/password เดียวกับที่ Directus ใช้ (หรือบัญชีที่ได้รับอนุญาต)  
ไม่ควรใส่รหัสผ่านลงในไฟล์ repo — ใช้ตัวแปรสภาพแวดล้อมหรือ `.env` ที่ไม่ commit

## หมายเหตุ

- ถ้าชื่อคอลัมน์จริงใน MSSQL ต่างจากใน `export-from-mssql-patient_info.sql` ให้แก้ query ให้ตรง แล้วยังคง **ลำดับคอลัมน์** ให้เท่ากับ staging
- ถ้า `DateOfBirth` format ไม่ใช่ `YYYY-MM-DD...` ต้องปรับ expression ใน `02_insert_into_clone_patient_info.sql`
