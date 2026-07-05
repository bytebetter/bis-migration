# Baseline selective dump (schema + partial data)

ไฟล์ `bisinfo_selective_initial.sql` เป็น snapshot ตั้งต้นของระบบ (schema เต็ม + ข้อมูลตาราง whitelist ตาม `scripts/db-selective-tables.inc.sh`)

## สร้างใหม่เมื่อ schema ต้นทางเปลี่ยน

จากเครื่องที่มี `kubectl` เข้า cluster ต้นทางได้:

```bash
./scripts/refresh-baseline.sh
```

ค่าเริ่มต้น: context `bb-dev-cluster`, pod `postgresql-0`, ฐาน `bisinfo_dev`  
ปรับได้ด้วย env `K8S_CONTEXT`, `K8S_NAMESPACE`, `POSTGRES_POD`, `SOURCE_DB`

หรือใช้สคริปต์ dump ทั่วไป (ต้องตั้ง `PGPASSWORD` เอง):

```bash
./scripts/db-dump-selective-backup.sh
# แล้วคัดลอกไฟล์ไป baseline/bisinfo_selective_initial.sql
```

## Restore

```bash
psql -U bis -d bisinfo -v ON_ERROR_STOP=1 -f baseline/bisinfo_selective_initial.sql
```

หรือผ่าน Docker ดู `docs/production-docker-restore.md`
