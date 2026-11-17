# Selective DB migration & backup

แพ็กเกจนี้แยกจากโปรเจ็กต์แอปหลักไว้สำหรับ **clone / migrate / dump** ฐานข้อมูลแบบเลือกตาราง (Directus + whitelist) เพื่อนำไป push เป็น Git repository แยกได้

## โครงสร้าง

- `scripts/db-selective-tables.inc.sh` — รายชื่อตารางที่ย้ายข้อมูลร่วมกัน
- `scripts/db-migrate-selective.sh` — migrate จาก DB ต้นทางไป DB ปลายทางผ่าน `kubectl exec`
- `scripts/db-dump-selective-backup.sh` — สร้างไฟล์ `.sql` สำหรับ restore บนเครื่องอื่น
- `scripts/refresh-baseline.sh` — อัปเดต `baseline/bisinfo_selective_initial.sql` จาก Supabase (`SOURCE_DATABASE_URL`) หรือจาก Kubernetes pod
- `scripts/db-flows-sync.sh` — sync Directus flows + operations แบบ git-mediated (export → commit → compare/apply บน prod)
- `flows.config.example.json` — เทมเพลต JSON สำหรับ source/dest (คัดลอกเป็น `flows.config.json` ที่ gitignore)
- `exports/directus-flows/` — snapshot ที่ commit สำหรับ sync ไป private prod
- `docs/db-migration-selective-runbook.md` — คู่มือรันจริงและ restore
- `docs/directus-flows-sync-runbook.md` — คู่มือ sync flows (สองเครื่องผ่าน git)
- `docs/production-docker-restore.md` — ติดตั้ง Postgres 16 ด้วย Docker + restore dump บน production server
- `docker/docker-compose.yml` — **Postgres 16 + Directus 11 + BIS Backoffice (Next.js)** (แนะนำ)
- `docker/docker-compose.postgres.yml` — Postgres อย่างเดียว
- `docker/docker-compose.directus.yml` — Directus อย่างเดียว (DB ภายนอก)
- `docs/local-stack-docker.md` — รันทั้งสแต็ก (Postgres + Directus + Backoffice)
- `docs/directus-docker.md` — Directus + Postgres (ไม่รวม Next.js)
- `directus-extensions-bb-dev/` — snapshot extensions จาก Directus บน `bb-dev-cluster` (คัดลอกไป volume `/directus/extensions`)
- `bis-image-assets/` — ไฟล์รูป/SVG สำหรับ Directus หรือ backoffice (เช่น `Content.svg`)
- `baseline/bisinfo_selective_initial.sql` — **ไฟล์ dump ตั้งต้นของระบบ** (track ใน Git) ดู [baseline/README.md](baseline/README.md)

ไฟล์ dump ชั่วคราวจากสคริปต์จะถูกเขียนลง `backups/` (โฟลเดอร์นี้ถูก ignore โดย `.gitignore`)

## ใช้งาน

**กรณี A:** โฟลเดอร์ `db-selective-migration/` อยู่ใต้ repo อื่น (เช่น [bis-migration](https://github.com/bytebetter/bis-migration)) — ให้ `cd db-selective-migration` จาก root ของ repo นั้นก่อนรันสคริปต์

**กรณี B:** คัดลอกเนื้อหาใน `db-selective-migration/` ไปเป็น **root ของ repo ใหม่** — รันจาก root ของ repo นั้นได้เลย (ไม่ต้อง `cd db-selective-migration`)

```bash
chmod +x scripts/*.sh
cp docker/supabase.env.example .env.supabase
# ใส่ Direct connection URI แล้ว
set -a && source .env.supabase && set +a
./scripts/refresh-baseline.sh
# หรือ ./scripts/db-dump-selective-backup.sh

# Flow-only sync via git snapshot (ดู docs/directus-flows-sync-runbook.md)
cp flows.config.example.json flows.config.json
# เครื่องที่ถึง source: ใส่ source.databaseUrl / source.schema แล้ว
./scripts/db-flows-sync.sh export
# commit exports/directus-flows/ แล้ว push — บน prod: pull, ใส่ dest.* แล้ว compare/apply
```

## นำไป repo อื่น

คัดลอกทั้งโฟลเดอร์ `db-selective-migration/` ไปเป็น root ของ repository ใหม่ หรือใช้ `git subtree split` / copy ไฟล์ตามต้องการ
