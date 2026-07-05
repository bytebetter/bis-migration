# Production: PostgreSQL ด้วย Docker + restore ไฟล์ selective dump

ไฟล์ dump จาก `db-dump-selective-backup.sh` ถูกสร้างด้วย **PostgreSQL 16** — restore ด้วย **`psql`** (ไม่ใช่ `pg_restore`) หรือรัน SQL ผ่าน client อื่น (เช่น TablePlus Query)

> สคริปต์ dump จะลบ `\\restrict` / `\\unrestrict` ออกให้แล้ว (เป็น meta-command ของ `psql` เท่านั้น ไม่ใช่ SQL)

## ไฟล์ตั้งต้นใน Git (baseline)

ไฟล์ **`baseline/bisinfo_selective_initial.sql`** ใน repo เป็น snapshot ตั้งต้นของระบบ (track ใน Git) — ใช้เป็นค่าเริ่มตอนติดตั้ง Postgres ใหม่ได้เลย โดยไม่ต้องหาไฟล์จากเครื่องอื่น

ตัวอย่าง restore จาก repo clone แล้ว:

```bash
cd /path/to/bis-migration/db-selective-migration
set -a && source .env.postgres && set +a
docker compose --env-file .env.postgres -f docker/docker-compose.postgres.yml exec -T postgres \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1 \
  < baseline/bisinfo_selective_initial.sql
```

## 1) ติดตั้ง PostgreSQL ผ่าน Docker

รันบน production server จากโฟลเดอร์ `db-selective-migration/` ของ repo นี้

```bash
cd /path/to/bis-migration/db-selective-migration
cp docker/postgres.env.example .env.postgres
# แก้ POSTGRES_PASSWORD และชื่อฐาน POSTGRES_DB ให้ตรงกับที่ต้องการ

docker compose --env-file .env.postgres -f docker/docker-compose.postgres.yml up -d
docker compose --env-file .env.postgres -f docker/docker-compose.postgres.yml ps
```

รอจน health เป็น healthy (หรือรอ ~10 วินาที) แล้วค่อย restore

ทางเลือกแบบ `docker run` (ไม่ใช้ compose ใน repo) — ชื่อ container คือ `bis-postgres` ใช้กับคำสั่ง `docker exec` ในข้อ 2

```bash
docker volume create bis_pgdata

docker run -d --name bis-postgres \
  --restart unless-stopped \
  -e POSTGRES_USER=bis \
  -e POSTGRES_PASSWORD='STRONG_PASSWORD' \
  -e POSTGRES_DB=bisinfo \
  -v bis_pgdata:/var/lib/postgresql/data \
  -p 127.0.0.1:5432:5432 \
  postgres:16-alpine
```

## 2) Restore ข้อมูลจากไฟล์ `.sql`

สมมติไฟล์ dump อยู่ที่ `/opt/bis/backups/bisinfo_selective.sql` บนเครื่องเดียวกับ Docker

### วิธี A — ส่ง stdin เข้า container (แนะนำ)

```bash
docker exec -i bis-postgres psql -U bis -d bisinfo -v ON_ERROR_STOP=1 < /opt/bis/backups/bisinfo_selective.sql
```

ถ้าใช้ compose จากไฟล์ใน repo:

```bash
cd /path/to/bis-migration/db-selective-migration
set -a && source .env.postgres && set +a
docker compose --env-file .env.postgres -f docker/docker-compose.postgres.yml exec -T postgres \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1 \
  < /opt/bis/backups/bisinfo_selective.sql
```

### วิธี B — ไฟล์ `.sql.gz`

ด้วย `docker run` (container ชื่อ `bis-postgres`):

```bash
gunzip -c /opt/bis/backups/bisinfo_selective.sql.gz | docker exec -i bis-postgres psql -U bis -d bisinfo -v ON_ERROR_STOP=1
```

ด้วย Docker Compose (service ชื่อ `postgres`):

```bash
cd /path/to/bis-migration/db-selective-migration
set -a && source .env.postgres && set +a
gunzip -c /opt/bis/backups/bisinfo_selective.sql.gz | docker compose --env-file .env.postgres -f docker/docker-compose.postgres.yml exec -T postgres \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1
```

## หมายเหตุ

- สร้างฐาน `bisinfo` (หรือชื่อใน `POSTGRES_DB`) ให้ว่างก่อน restore — image สร้างให้แล้วตอน first boot
- ถ้า restore ล้มเหลวเรื่องสิทธิ์หรือ extension ให้ใช้ user เดียวกับที่สร้างจาก `POSTGRES_USER` (เป็น superuser ใน container เริ่มต้น)
- อย่าเปิดพอร์ต `0.0.0.0:5432` ถ้าไม่จำเป็น — ใน compose ตั้งเป็น `127.0.0.1` แล้ว
- หลัง restore ควรเปลี่ยนรหัสผ่าน / จำกัด network และ backup volume `bis_pgdata` ตามนโยบายองค์กร

## Restore ผ่าน TablePlus

ไฟล์ `baseline/bisinfo_selective_initial.sql` ใน Git ใช้รูปแบบ **`COPY ... FROM stdin`** (เหมาะกับ `psql` / Docker) — **TablePlus รันไม่ได้**

| วิธีใน TablePlus | ไฟล์ที่ต้องใช้ | หมายเหตุ |
|------------------|----------------|----------|
| **Restore Database** | ไม่รองรับ `.sql` plain | ใช้ได้เฉพาะ `pg_dump -Fc` (custom format) |
| **Execute SQL file** | ต้องเป็น `INSERT` ไม่ใช่ `COPY` | สร้างด้วย `SQL_DATA_FORMAT=inserts` |

สร้างไฟล์สำหรับ TablePlus:

```bash
SQL_DATA_FORMAT=inserts OUTPUT_PATH=backups/bisinfo_selective_tableplus.sql ./scripts/refresh-baseline.sh
```

จากนั้นใน TablePlus (ฐานว่าง, ปิด Directus ก่อน):

1. อย่าใช้ **Restore Database**
2. เปิด **Query** → **Execute SQL file** → เลือก `bisinfo_selective_tableplus.sql`

ไฟล์แบบ `inserts` จะใหญ่กว่าและ restore ช้ากว่า — แนะนำใช้ `docker exec ... psql` บน production ถ้าทำได้
