# Directus ด้วย Docker Compose

ใช้คู่กับ Postgres 16 จาก `docker/docker-compose.postgres.yml` และฐาน `bisinfo` ที่ restore จาก selective dump (มีตาราง `directus_*` อยู่แล้ว)

## 1) เตรียม env

```bash
cd /path/to/bis-migration/db-selective-migration
cp docker/postgres.env.example .env.postgres
cp docker/directus.env.example .env.directus
```

แก้ใน `.env.directus`:

- `DB_PASSWORD` ให้ตรงกับ `.env.postgres`
- `KEY` / `SECRET` — สุ่มครั้งเดียวแล้วเก็บไว้ (เช่น `openssl rand -hex 16` และ `openssl rand -hex 32`)
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — มีผลเฉพาะตอนติดตั้ง Directus บนฐานว่าง; ถ้า restore จาก `baseline/bisinfo_selective_initial.sql` แล้ว ให้ล็อกอินด้วย user จาก `directus_users` เดิม

## 2) รัน Postgres + Directus

```bash
docker compose \
  --env-file .env.postgres \
  --env-file .env.directus \
  -f docker/docker-compose.yml \
  up -d
```

ตรวจสถานะ:

```bash
docker compose --env-file .env.postgres --env-file .env.directus \
  -f docker/docker-compose.yml ps
```

เปิด UI: [http://localhost:8055](http://localhost:8055) (bind ที่ `127.0.0.1` เท่านั้น — เปิดจากเครื่อง server หรือ SSH tunnel)

## 3) Restore ฐานก่อนเปิด Directus (ครั้งแรก)

ถ้ายังไม่มีข้อมูลใน Postgres:

```bash
set -a && source .env.postgres && set +a
docker compose --env-file .env.postgres -f docker/docker-compose.yml exec -T postgres \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1 \
  < baseline/bisinfo_selective_initial.sql
```

จากนั้นค่อย `up -d` Directus ตามข้อ 2

## Postgres รันอยู่แล้ว / คนละเครื่อง

ใน `.env.directus` ตั้ง `DB_HOST` เป็น hostname ที่ Directus container เข้าถึงได้ (เช่น IP ภายใน LAN หรือ `host.docker.internal` บน Docker Desktop) แล้วรันเฉพาะ:

```bash
docker compose --env-file .env.directus -f docker/docker-compose.directus.yml up -d
```

## ไฟล์อัปโหลด (uploads)

ไฟล์ใน `directus_files` อ้างอิง path ใน volume `directus_uploads` — ถ้า migrate จาก production ต้อง copy โฟลเดอร์ uploads จาก Directus เดิมมาด้วย (หรือ mount path เดิมเข้า volume)

## หยุด / ลบ

```bash
docker compose --env-file .env.postgres --env-file .env.directus \
  -f docker/docker-compose.yml down
```

Volume `directus_uploads` / `directus_extensions` ไม่ถูกลบเมื่อ `down` (ไม่ใส่ `-v`)
