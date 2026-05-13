# Baseline selective dump (schema + partial data)

ไฟล์ `bisinfo_selective_initial.sql` เป็น snapshot ตั้งต้นของระบบ (สร้างจาก `db-dump-selective-backup.sh` ตามรายการตารางใน `scripts/db-selective-tables.inc.sh`)

Restore บน Postgres 16 ว่าง:

```bash
psql -U bis -d bisinfo -v ON_ERROR_STOP=1 -f baseline/bisinfo_selective_initial.sql
```

หรือผ่าน Docker ดู `docs/production-docker-restore.md`
