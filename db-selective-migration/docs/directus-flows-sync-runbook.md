# Directus flows sync (source → production)

ซิงก์เฉพาะตาราง `directus_flows` + `directus_operations` จาก DB ต้นทางไปปลายทาง (เช่น private production) แบบ **compare → approve → backup → apply** และมีคำสั่ง **restore** จาก backup ที่ตั้งชื่อได้

ใช้ DB dump/diff/apply ผ่าน `psql` / `pg_dump` ตามแนวเดียวกับ selective migration — **ไม่ได้** พึ่ง `directus-extension-sync` (ยังมีอยู่ใน repo แต่ไม่จำเป็นสำหรับ flow-only sync นี้)

## ไฟล์ที่เกี่ยวข้อง

| Path | บทบาท |
|------|--------|
| `docker/flows.env.example` | เทมเพลต config (คัดลอกเป็น `.env.flows`) |
| `.env.flows` | secrets จริง (gitignored) |
| `scripts/db-flows-sync.sh` | CLI หลัก |
| `scripts/db-flows-common.inc.sh` | helpers + reuse `db-selective-tables.inc.sh` |
| `backups/flows/` | export / dated backups (gitignored ผ่าน `/backups/`) |

## 1) Configure

```bash
cd db-selective-migration
cp docker/flows.env.example .env.flows
# ใส่ SOURCE_DATABASE_URL + DEST_DATABASE_URL (และ schema)
# ถ้า prod ฟังแค่ 127.0.0.1 ให้ตั้ง DEST_SSH_* หรือเปิด tunnel เอง
set -a && source .env.flows && set +a
chmod +x scripts/db-flows-sync.sh
```

### Source (เช่น Supabase / Fly backoffice-dev)

- ใช้ Direct connection (`:5432`) เหมือน `docker/supabase.env.example`
- `SOURCE_SCHEMA=bis_dev` ถ้า Directus อยู่ schema นั้น

### Destination (private prod)

- `DEST_DATABASE_URL` ชี้ Postgres ของ prod
- `DEST_SCHEMA=public` ตาม Docker prod ใน repo นี้

### SSH tunnel (optional)

ถ้า Postgres บน server bind `127.0.0.1:5432` ให้ตั้งใน `.env.flows`:

```bash
DEST_SSH_HOST=user@prod-server
DEST_SSH_LOCAL_PORT=15432
DEST_SSH_REMOTE_HOST=127.0.0.1
DEST_SSH_REMOTE_PORT=5432
DEST_DATABASE_URL=postgresql://bis:PASSWORD@127.0.0.1:15432/bisinfo
```

สคริปต์จะเปิด `ssh -L` ให้อัตโนมัติเมื่อมี `DEST_SSH_HOST` (และปิดตอนจบถ้าเป็น process ที่มันเปิดเอง)

## 2) Compare (default / dry-run)

ไม่เขียนอะไรลงปลายทาง

```bash
./scripts/db-flows-sync.sh compare
# หรือแค่: ./scripts/db-flows-sync.sh
```

สรุปแบบมนุษย์อ่านได้: **added / removed / changed** ของ flows และ operations (เทียบ fingerprint ของเนื้อหา — ค่าเริ่มต้นไม่นับ `date_created` / `user_created`; ตั้ง `CONTENT_ONLY=false` ถ้าต้องการเทียบรวม)

exit code `1` ถ้ามี diff, `0` ถ้าตรงกัน

## 3) Export (optional)

```bash
./scripts/db-flows-sync.sh export --side source
./scripts/db-flows-sync.sh export --side dest --out /tmp/dest-flows.sql
```

## 4) Approve + apply

ลำดับใน `apply`:

1. รัน compare อีกครั้ง
2. ขออนุมัติ — พิมพ์ `yes` หรือส่ง `--approve` (หลังรีวิวแล้ว) สำหรับ non-interactive
3. **backup ปลายทางเสมอ** → `backups/flows/<YYYYMMDD_HHMMSS>/`
4. แทนที่ข้อมูล flows/operations บน dest ด้วยของ source (`TRUNCATE` + load ภายใต้ `session_replication_role=replica` เพื่อวน FK)
5. compare ซ้ำเพื่อ verify

```bash
./scripts/db-flows-sync.sh apply
# หรือหลังรีวิว diff แล้ว:
./scripts/db-flows-sync.sh apply --approve
```

> สคริปต์นี้ **ไม่** ชี้ production ให้เอง — คุณต้องใส่ `DEST_*` เอง และต้อง approve ก่อนเขียน

ต้องการแค่ backup ปลายทางโดยไม่ apply:

```bash
./scripts/db-flows-sync.sh backup
```

## 5) Restore

```bash
ls backups/flows/
./scripts/db-flows-sync.sh restore 20261117_153045
# non-interactive:
./scripts/db-flows-sync.sh restore 20261117_153045 --approve
```

ก่อน restore จะสร้าง safety backup ของสถานะปัจจุบัน (`*_pre_restore`) ให้อัตโนมัติ

แต่ละโฟลเดอร์ backup มี `README.txt` สั้นๆ และไฟล์ `directus_flows_operations.sql`

## ข้อควรรู้

- ต้องมีสิทธิ์พอบน dest สำหรับ `TRUNCATE` และ `SET session_replication_role` (user ใน Docker Postgres เริ่มต้นมักเป็น superuser ของ instance นั้น)
- ไม่แตะตาราง Directus อื่น (permissions, users, …)
- หลัง apply บน prod ที่ Directus กำลังรันอยู่ อาจต้อง reload/restart Directus ถ้า UI แคช flow เก่า
- อย่า commit `.env.flows` หรือไฟล์ใต้ `backups/`
