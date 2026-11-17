# Directus flows sync runbook

ซิงก์เฉพาะ `directus_flows` + `directus_operations` จากแพ็กเกจ **`directus-flows-sync/`** (standalone) โดยไม่ต้อง SSH ไปหา prod:

1. เครื่องที่เข้าถึง **source** DB ได้ → `export` → **commit + push** `exports/`
2. บน **private production server** → `git pull` → `compare` / `apply` / `restore` กับ Postgres ท้องถิ่น (`dest` เท่านั้น)

## Config (JSON)

```bash
cd directus-flows-sync
cp flows.config.example.json flows.config.json
```

```json
{
  "source": { "databaseUrl": "postgresql://…", "schema": "bis_dev" },
  "dest": { "databaseUrl": "postgresql://bis:…@127.0.0.1:5432/bisinfo", "schema": "public" },
  "exportSchema": "public",
  "snapshotDir": "exports",
  "contentOnly": true,
  "pg": {
    "useDocker": false,
    "clientImage": "postgres:17-alpine",
    "dumpMinMajor": 17,
    "dockerHost": "host.docker.internal",
    "dockerNetwork": ""
  }
}
```

| Field | ใช้ตอน | หมายเหตุ |
|-------|--------|----------|
| `source.*` | export | |
| `dest.*` | compare / apply / restore | |
| `exportSchema` | export | schema ใน SQL ที่ commit |
| `pg.useDocker` | ทุกคำสั่ง | `false` = ใช้ `psql`/`pg_dump` บน host (แนะนำบน prod) |
| `pg.dockerHost` | เมื่อ client เป็น Docker | แทนที่ `127.0.0.1`/`localhost` ใน URL |
| `pg.dockerNetwork` | เมื่อ client เป็น Docker | เข้าร่วม Docker network ของ compose (เช่น `bis-infra_default`) |

Override: `./scripts/sync.sh --config /path/to.json compare`

### Password มี `@`

ต้อง %-encode เป็น `%40` ใน URL เช่น `postgresql://bis:p%40ss@127.0.0.1:5432/bisinfo`

## Prod + Postgres ใน Docker (connection refused)

อาการ: `connection to server at "127.0.0.1", port 5432 failed: Connection refused` ทั้งที่ `docker ps` แสดง `0.0.0.0:5432->5432`

**สาเหตุที่พบบ่อย:** สคริปต์รัน `psql`/`pg_dump` **ใน container** (`pg.useDocker: true` หรือไม่มี client บน host) แล้วชี้ `127.0.0.1` — ใน container นั้นคือตัวมันเอง ไม่ใช่ host ที่ map พอร์ต 5432

เลือกอย่างใดอย่างหนึ่ง:

### A) แนะนำ — host client (`useDocker: false`)

ติดตั้ง `psql` บน host (หรือใช้ client ที่มากับ distro) แล้ว:

```json
"dest": {
  "databaseUrl": "postgresql://bis:PASSWORD@127.0.0.1:5432/bisinfo",
  "schema": "public"
},
"pg": { "useDocker": false }
```

ตรวจเร็วๆ: `psql "postgresql://bis:PASSWORD@127.0.0.1:5432/bisinfo" -c 'select 1'`

### B) Docker client + host gateway

ถ้าต้องใช้ Docker client ให้คง URL เป็น `127.0.0.1` ได้ — สคริปต์จะ rewrite เป็น `host.docker.internal` และใส่ `--add-host=host.docker.internal:host-gateway`:

```json
"dest": {
  "databaseUrl": "postgresql://bis:PASSWORD@127.0.0.1:5432/bisinfo",
  "schema": "public"
},
"pg": {
  "useDocker": true,
  "dockerHost": "host.docker.internal"
}
```

### C) Docker client + join compose network

ไม่ใช้ loopback — ชี้ชื่อ service ใน network ของ stack (ดู `docker network ls` / `docker inspect`):

```json
"dest": {
  "databaseUrl": "postgresql://bis:PASSWORD@postgres:5432/bisinfo",
  "schema": "public"
},
"pg": {
  "useDocker": true,
  "dockerNetwork": "bis-infra_default"
}
```

(แทน `postgres` ด้วยชื่อ service จริง เช่นจาก compose ของ `bis-infra-postgres-1`)

## Stage A — Export

```bash
./scripts/sync.sh export
git add exports/
git commit -m "Update Directus flows snapshot"
git push
```

## Stage B — Prod

```bash
git pull
# flows.config.json มี dest.* เท่านั้นก็พอ
./scripts/sync.sh compare
./scripts/sync.sh check-deps          # สแกน deps นอก flows/ops (มี dest จะ probe collection/folder ที่ขาด)
./scripts/sync.sh check-deps --strict # exit 1 ถ้า dest ขาด collection/folder ที่ snapshot อ้าง
./scripts/sync.sh apply
./scripts/sync.sh apply --approve
./scripts/sync.sh backup
./scripts/sync.sh restore <YYYYMMDD_HHMMSS>
```

## External deps (ก่อน apply)

Snapshot ซิงก์แค่ `directus_flows` + `directus_operations` — แต่ options JSON อาจอ้างของนอกกราฟ:

| ชนิด | ตรวจด้วย | หมายเหตุ |
|------|----------|----------|
| collections | `check-deps` | ส่วนใหญ่เป็นตารางแอป (+ `environment_data`, `directus_*`) |
| `directus_folders` UUID | `check-deps` (+ dest probe) | hardcode ในย้ายไฟล์ |
| request URLs | `check-deps` | ส่วนใหญ่ผ่าน `{{read_environment.url}}` |
| `$env` / roles / webhooks | `check-deps` | ใน snapshot ปัจจุบันแทบไม่มี |
| custom op types | `check-deps` | ต้องมี extension บน dest (เช่น `pricing-operation`) |
| `environment_data` | มือ / DB | แถวที่ flow อ่าน `url` + `access_token` |

รันตรง ๆ กับไฟล์ SQL ก็ได้:

```bash
python3 scripts/check-deps.py exports/directus_flows_operations.sql
python3 scripts/check-deps.py --json   # สำหรับ script
```

## Git hygiene

| Commit | Ignore |
|--------|--------|
| `exports/**`, `flows.config.example.json`, scripts, docs | `flows.config.json`, `backups/**` |
