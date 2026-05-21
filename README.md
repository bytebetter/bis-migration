# BIS-DB-Migration

เครื่องมือย้ายข้อมูล MSSQL / CSV → PostgreSQL (Directus) — แยกจาก front-end **BIS-Backoffice**

## เมื่อได้ลิงก์ repo จากหัวหน้า

```powershell
cd $HOME\Documents   # หรือโฟลเดอร์ที่ทีมกำหนด
git clone <url> BIS-DB-Migration
cd BIS-DB-Migration

# ที่ root repo เท่านั้น: npm install ครั้งเดียว แล้วรันตารางเดียวหรือทุกตาราง
npm install
npm run migrate:all
# หรือทีละตาราง: npm run migrate:patient_info , npm run migrate:appointment , …
```

`run-migrate.ps1` / `run-migrate-all.ps1` จะเรียกติดตั้งให้อัตโนมัติถ้ายังไม่มี `node_modules/mssql` และ `node_modules/pg` ที่ root (ยกเว้นระบุ `-SkipInstall`)

เปิดโฟลเดอร์นี้เป็น workspace ใน Cursor/VS Code จะใช้ **Tasks** ใน `.vscode/tasks.json` (เรียก `npm run migrate:...` / `migrate:all` จาก root) หรือรัน task **migrate: npm install (repository root)** ก่อนครั้งแรก

ตั้งค่าเชื่อมต่อจากไฟล์กลางที่ root:
- `migration.config.example.json` (template)
- `migration.config.local.json` (ใช้งานจริง, แยกตาม profile)

## รัน migrate ทุกตารางทีเดียว (`npm run migrate:all` / `run-migrate-all.ps1`)

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

3. (ถ้ายังไม่ได้รัน) ที่ root repo รัน **`npm install` ครั้งเดียว** — เก็บ `mssql` และ `pg` ร่วมกันทุกตาราง  

ครั้งแรกที่รัน `./run-migrate.ps1` หรือ `./run-migrate-all.ps1` **ถ้าไม่ใส่ `-SkipInstall`** สคริปต์จะตรวจและรัน `npm install` ที่ root ให้เมื่อยังไม่ครบแพ็กเกจที่ต้องการ

### คำสั่ง

จาก root โปรเจกต์:

```powershell
cd C:\path\to\BIS-DB-Migration

# รันทั้ง 12 ตาราง (แนะนำ — หลัง npm install ที่ root แล้ว)
npm run migrate:all

# หรือสคริปต์ PowerShell โดยตรง (เทียบเท่า — จะติดตั้งที่ root ให้ถ้ายังไม่มีแพ็กเกจ)
.\run-migrate-all.ps1

# ข้ามการตรวจ/ติดตั้ง dependencies ที่ root (คุณติดตั้ง npm ที่ root ด้วยตัวเองแล้ว)
.\run-migrate-all.ps1 -SkipInstall

# เริ่มจากตารางที่ 3 (examination) ถ้า 1–2 เสร็จแล้ว
.\run-migrate-all.ps1 -StartFrom 3 -SkipInstall

# เลือกเฉพาะบางตาราง (ชื่อใน pipeline — ดูตารางลำดับด้านบน)
.\run-migrate-all.ps1 -Tables appointment,examination -SkipInstall

# ช่วงคีย์ MSSQL (appointment → Schedule_ID / examination → Exam_ID)
.\run-migrate-all.ps1 -Tables appointment -SourceKeyRange "1-100" -SkipInstall
```

### โหมดรัน (`-MigrateRunMode`) — มี 3 แบบ

| โหมด | พารามิเตอร์ | เมื่อไหร่ใช้ |
|------|-------------|-------------|
| **1. resume** (ดีฟอลต์) | ไม่ใส่ หรือ `-MigrateRunMode resume` | รันปกติ / รันต่อหลังหยุดกลางคัน — **ไม่ทับ**แถวที่มีใน Postgres แล้ว |
| **2. overwrite** | `-MigrateRunMode overwrite` | ต้องการ migrate **ทั้งชุดใหม่** และ **เขียนทับ**ข้อมูลเดิม |
| **3. repair-from-log** | `-MigrateRunMode repair-from-log` | แก้เฉพาะแถวที่ error / field issue จาก **log ล่าสุด** |

รองรับทั้ง **12 ตาราง** ใน pipeline

| โหมด | checkpoint | เขียนทับ Postgres |
|------|------------|-------------------|
| resume | เปิด — อ่าน/บันทึกที่ `<ตาราง>/js-migrate/checkpoints/` | ไม่ทับ (insert-only) |
| overwrite | ปิด — เริ่มจากต้นทาง | เขียนทับ |
| repair-from-log | ปิด — ไม่ใช้ checkpoint | เขียนทับเฉพาะ id ที่ดึงจาก log |

Log ที่โหมด **repair-from-log** อ่าน (ไฟล์ **ล่าสุด** ใน `<ตาราง>/js-migrate/logs/`):

- `migrate-*.json` — chunk ล้มเหลว, สถิติ run
- `migration-field-issues-*.json` — รายการ id ที่มี field issue

---

### วิธีใช้แต่ละโหมด

#### โหมด 1 — resume (ดีฟอลต์)

ใช้เมื่อ migrate ครั้งแรกหรือรันต่อจากครั้งก่อน ระบบจะข้ามแถวที่มีใน Postgres แล้ว และจำตำแหน่งล่าสุดใน checkpoint

```powershell
# ทุกตาราง (ไม่ต้องใส่ -MigrateRunMode)
.\run-migrate-all.ps1 -SkipInstall

# เฉพาะ examination
.\run-migrate-all.ps1 -Tables examination -SkipInstall

# ทีละตาราง
.\examination\js-migrate\run-migrate.ps1 -SkipInstall
npm run migrate:examination
```

เริ่มใหม่แบบ resume (ลบ checkpoint ของตารางนั้นก่อน):

```powershell
Remove-Item .\examination\js-migrate\checkpoints\*.json -ErrorAction SilentlyContinue
.\examination\js-migrate\run-migrate.ps1 -SkipInstall
```

---

#### โหมด 2 — overwrite

ใช้เมื่อต้องการดึงข้อมูลจาก MSSQL **ทั้งชุดอีกครั้ง** และ **อัปเดตทับ**ของเดิมใน Postgres (ไม่ใช้ checkpoint)

```powershell
# ทุกตาราง
.\run-migrate-all.ps1 -MigrateRunMode overwrite -SkipInstall

# เฉพาะ examination
.\run-migrate-all.ps1 -Tables examination -MigrateRunMode overwrite -SkipInstall

# ทีละตาราง
.\examination\js-migrate\run-migrate.ps1 -MigrateRunMode overwrite -SkipInstall
npm run migrate:examination -- --migrate-run-mode overwrite
```

คำเตือน: โหมดนี้จะ migrate ข้อมูลจำนวนมากจากต้นทาง — ใช้เมื่อแน่ใจว่าต้องการทับข้อมูลเดิม

สำหรับ **`patient_info`**: overwrite จะ **UPDATE** แถวเดิมตาม `id` (ไม่ลบแล้ว INSERT ใหม่) เพื่อไม่ให้ FK ที่อ้าง `patient_info.id` หลุด — ที่อยู่ (`address`) จะลบแล้วใส่ใหม่ตาม `patient_info.id` นั้น

---

#### โหมด 3 — repair-from-log

ใช้หลังรัน migrate แล้วมี error หรือ field issue — จะอ่าน log **ล่าสุด** ของตารางนั้นแล้ว migrate เฉพาะ id ที่มีปัญหา

```powershell
# หลายตาราง
.\run-migrate-all.ps1 -Tables appointment,examination -MigrateRunMode repair-from-log -SkipInstall

# ตารางเดียว
.\examination\js-migrate\run-migrate.ps1 -MigrateRunMode repair-from-log -SkipInstall
npm run migrate:examination -- --migrate-run-mode repair-from-log
```

ตรวจ log ก่อนรัน (ตัวอย่าง examination):

```powershell
Get-ChildItem .\examination\js-migrate\logs\ | Sort-Object LastWriteTime -Descending | Select-Object -First 5 Name, LastWriteTime
```

ถ้าไม่มี id ใน log สคริปต์จะจบสำเร็จทันทีโดยไม่ migrate แถวใด

เมื่อรันจบ จะพิมพ์สรุปบน stderr เช่น:

```
>>> [patient_info] repair-from-log สรุปผล (patient_info): จาก log ต้องแก้ 3 รายการ (pid)
>>> [patient_info]   สำเร็จ: 2 เคส
>>> [patient_info]   ไม่สำเร็จ: 1 เคส
>>> [patient_info]     - ไม่พบใน MSSQL: 0 เคส
>>> [patient_info]     - แมป/ลง Postgres ไม่ผ่าน: 1 เคส
```

ค่าสรุปอยู่ใน `repairSummary` ของผลรัน / `migrate-*.json` ด้วย

---

### ชื่อตารางสำหรับ `-Tables`

`patient_info`, `appointment`, `examination`, `examination_general`, `pacs_sync_info`, `procedure`, `ultrasound`, `mammogram`, `mammogram_cal`, `mammogram_mass`, `ultrasound_cyst`, `ultrasound_mass`

### ช่วงคีย์ MSSQL (ใช้ร่วมกับโหมด resume / overwrite)

รองรับหลักที่ **appointment** (`Schedule_ID`) และ **examination** (`Exam_ID`):

```powershell
.\run-migrate-all.ps1 -Tables appointment -SourceKeyRange "1-5000" -SkipInstall
.\run-migrate-all.ps1 -Tables examination -SourceKeyFrom 9000 -SourceKeyTo 9500 -SkipInstall
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

รัน migrate ทีละตาราง: **`npm run migrate:<profile>`** จาก root หรือ `<โฟลเดอร์>/js-migrate/run-migrate.ps1` (โหลด `mssql`/`pg` จาก `<repo>/node_modules`). **ไม่มี `package.json` ใต้ `*/js-migrate`** — อย่ารัน `npm run`/`npm install` ในโฟลเดอร์ตาราง

**`npm run migrate:all`:** Windows ใช้ `powershell`; Linux และ macOS ต้องมี **[PowerShell 7 (`pwsh`)](https://learn.microsoft.com/powershell/scripting/install/installing-powershell)** เพื่อให้รัน `run-migrate-all.ps1` ได้ ถ้าไม่ติดตั้ง `pwsh` ให้เรียก **`npm run migrate:<ชื่อตาราง>`** ทีละงานจาก root

## โครงสร้าง

- **`patient-info/`** — migrate `patient_info` → [patient-info/README.md](patient-info/README.md)
- **`examination/`** — migrate `examination` → [examination/README.md](examination/README.md)
- **`appointment/`** — migrate `schedule` → `appointment` → [appointment/js-migrate/README.md](appointment/js-migrate/README.md)
- **`db-selective-migration/`** — clone schema + เลือกตาราง (Directus + whitelist) ผ่าน `kubectl` / `pg_dump` → [db-selective-migration/README.md](db-selective-migration/README.md) — ติดตั้ง Postgres บน server ด้วย Docker + restore: [db-selective-migration/docs/production-docker-restore.md](db-selective-migration/docs/production-docker-restore.md) — ไฟล์ SQL ตั้งต้นใน Git: [db-selective-migration/baseline/](db-selective-migration/baseline/)
- ตารางอื่นเพิ่มเป็นโฟลเดอร์ระดับเดียวกับ `patient-info/` ได้

## ความต้องการ

- Node 20+ และ `npm` — **ติดตั้ง dependencies กลางครั้งเดียวที่ root repo** (`npm install`; สคริปต์ migrate โหลดแพ็กเกจจาก `<repo>/node_modules/` ร่วมกันทุก `<ตาราง>/js-migrate`)
- การ port-forward ไป Postgres หรือ network ตามสภาพแวดล้อม
