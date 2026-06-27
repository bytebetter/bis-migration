# Local stack: Postgres + Directus + BIS Backoffice (Next.js)

รันทั้งสแต็กบนเครื่องเดียวด้วย Docker Compose ใน `docker/docker-compose.yml`

Backoffice ใช้ image สำเร็จรูป **`bytebetter/bis-backoffice:v1.0.0`** (ไม่ build จาก source ใน compose)

## 1) เตรียม env

```bash
cd /path/to/bis-migration/db-selective-migration
cp docker/postgres.env.example .env.postgres
cp docker/directus.env.example .env.directus
cp docker/backoffice.env.example .env.backoffice
```

แก้ `.env.backoffice` (ถ้าต้องการ):

| ตัวแปร | หมายเหตุ |
|--------|----------|
| `BACKOFFICE_IMAGE` | default `bytebetter/bis-backoffice:v1.0.0` |
| `BACKOFFICE_PORT` | default `3000` |
| `CORS_ORIGIN` | origin ของ backoffice สำหรับ Directus CORS |

แก้ `.env.directus` — `KEY` / `SECRET` ให้ตรงกับค่าที่ใช้ตอน **build image** `v1.0.0` (โดยเฉพาะ `SECRET` = `NEXT_PUBLIC_JWT_SECRET` ใน image)

## 2) รัน

```bash
docker compose \
  --env-file .env.postgres \
  --env-file .env.directus \
  --env-file .env.backoffice \
  -f docker/docker-compose.yml \
  up -d
```

ดึง image ใหม่ (ถ้ามี tag อัปเดต):

```bash
docker compose ... pull backoffice
docker compose ... up -d
```

| Service | URL |
|---------|-----|
| **Backoffice** | http://127.0.0.1:3000 |
| **Directus** | http://127.0.0.1:8055 |
| **Postgres** | 127.0.0.1:5432 |

## 3) Restore DB (ครั้งแรก)

```bash
set -a && source .env.postgres && set +a
docker compose --env-file .env.postgres -f docker/docker-compose.yml exec -T postgres \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1 \
  < baseline/bisinfo_selective_initial.sql
```

ล็อกอิน Backoffice ด้วย user จาก `directus_users` ใน dump

## 4) Extensions Directus

Compose mount `directus-extensions-bb-dev/` เข้า `/directus/extensions` อัตโนมัติ

## หมายเหตุ

- `NEXT_PUBLIC_*` อยู่ใน image แล้ว — ถ้า Directus URL ไม่ตรงกับตอน build ต้อง build/push image tag ใหม่
- Build จาก source เอง: ดู `docker/Dockerfile.backoffice` และ `bis-backoffice/Dockerfile.local-stack`
- บน Portainer ใช้ external volumes แทน bind mount ได้ — ดู docs เดิมเรื่อง volume names

## หยุด

```bash
docker compose --env-file .env.postgres --env-file .env.directus --env-file .env.backoffice \
  -f docker/docker-compose.yml down
```
