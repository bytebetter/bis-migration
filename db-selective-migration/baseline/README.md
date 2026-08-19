# Baseline selective dump (schema + partial data)

ไฟล์ `bisinfo_selective_initial.sql` เป็น snapshot ตั้งต้นของระบบ (schema เต็ม + ข้อมูลตาราง whitelist ตาม `scripts/db-selective-tables.inc.sh`)

## สร้างใหม่เมื่อ schema ต้นทางเปลี่ยน

แหล่งปัจจุบันคือ **Supabase (dev)** — dump จาก schema `SOURCE_SCHEMA` (เช่น `bis_dev`) แล้ว rewrite เป็น `TARGET_SCHEMA=public` สำหรับ restore บน prod

```bash
cp docker/supabase.env.example .env.supabase
# ใส่ Direct connection URI + SOURCE_SCHEMA=bis_dev + TARGET_SCHEMA=public
set -a && source .env.supabase && set +a
./scripts/refresh-baseline.sh
```

ต้องมี `pg_dump` **17+** ในเครื่อง หรือมี Docker (สคริปต์จะใช้ `postgres:17-alpine` อัตโนมัติถ้า local เป็น 14/16)

ทางเลือกเก่า (Kubernetes pod): ไม่ตั้ง `SOURCE_DATABASE_URL` แล้วรัน `./scripts/refresh-baseline.sh` — ค่าเริ่มต้น `bb-dev-cluster` / `postgresql-0` / `bisinfo_dev`

หรือ dump ไป `backups/` แทนการเขียนทับ baseline:

```bash
set -a && source .env.supabase && set +a
./scripts/db-dump-selective-backup.sh
```

## Restore

```bash
psql -U bis -d bisinfo -v ON_ERROR_STOP=1 -f baseline/bisinfo_selective_initial.sql
```

หรือผ่าน Docker ดู `docs/production-docker-restore.md`
