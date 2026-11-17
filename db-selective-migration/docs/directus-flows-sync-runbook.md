# Directus flows sync (git-mediated, two machines)

ซิงก์เฉพาะ `directus_flows` + `directus_operations` โดย **ไม่ต้อง SSH** ไปหา prod:

1. เครื่องที่เข้าถึง **source** DB ได้ → `export` เป็นไฟล์ใน repo → **commit + push**
2. บน **private production server** → `git pull` → `compare` / `apply` / `restore` กับ Postgres ท้องถิ่น (DEST เท่านั้น)

ใช้ DB dump/diff/apply ผ่าน `psql` / `pg_dump` ตามแนว selective migration — **ไม่ได้** พึ่ง `directus-extension-sync`

## ไฟล์ที่เกี่ยวข้อง

| Path | Git? | บทบาท |
|------|------|--------|
| `exports/directus-flows/` | **commit** | snapshot จาก source (SQL + fingerprints) |
| `docker/flows.env.example` | commit | เทมเพลต config |
| `.env.flows` | **ignore** | secrets จริง |
| `backups/flows/` | **ignore** | runtime backup ก่อน apply/restore |
| `scripts/db-flows-sync.sh` | commit | CLI |

## Stage A — Export (เครื่องที่ถึง source)

```bash
cd db-selective-migration
cp docker/flows.env.example .env.flows
# ใส่ SOURCE_DATABASE_URL + SOURCE_SCHEMA (+ EXPORT_SCHEMA=public)
# DEST_* ไม่จำเป็นในขั้นนี้
set -a && source .env.flows && set +a

./scripts/db-flows-sync.sh export
```

เขียนลง `exports/directus-flows/`:

- `directus_flows_operations.sql` — data-only INSERTs (schema = `EXPORT_SCHEMA`)
- `fingerprints/*.tsv` — สำหรับ compare บน prod โดยไม่ต้องมี live source
- `MANIFEST` — metadata (เวลา, schema, counts)
- `README.md` — คำอธิบายสั้นๆ

แล้ว commit ชุดนี้ intentionally:

```bash
git add exports/directus-flows/
git commit -m "Update Directus flows snapshot"
git push
```

## Stage B — Apply บน private prod server

Server คุยกับ Postgres ของตัวเองได้โดยตรง — **ไม่ต้อง** `SOURCE_*` และ **ไม่ต้อง** SSH tunnel

```bash
cd /path/to/bis-migration/db-selective-migration
git pull

cp docker/flows.env.example .env.flows   # ครั้งแรก
# ใส่เฉพาะ DEST_DATABASE_URL + DEST_SCHEMA (เช่น 127.0.0.1:5432)
set -a && source .env.flows && set +a
```

### Compare (default / dry-run)

เทียบ **committed snapshot** กับ dest สด — ไม่เขียน DB

```bash
./scripts/db-flows-sync.sh compare
```

สรุป **added / removed / changed** (ค่าเริ่มต้นไม่นับ `date_created` / `user_created`)

### Approve + apply

1. compare อีกครั้ง  
2. approve — พิมพ์ `yes` หรือ `--approve`  
3. **backup dest เสมอ** → `backups/flows/<stamp>/` (gitignored)  
4. แทนที่ flows/operations จาก snapshot SQL  
5. compare ซ้ำเพื่อ verify  

```bash
./scripts/db-flows-sync.sh apply
./scripts/db-flows-sync.sh apply --approve
```

### Backup อย่างเดียว / Restore

```bash
./scripts/db-flows-sync.sh backup
ls backups/flows/
./scripts/db-flows-sync.sh restore 20261117_153045
./scripts/db-flows-sync.sh restore 20261117_153045 --approve
```

ก่อน restore จะสร้าง safety backup (`*_pre_restore`) ให้อัตโนมัติ

## Git hygiene

| เก็บใน git | ไม่เก็บ |
|------------|---------|
| `exports/directus-flows/**` (snapshot ที่ export แล้ว) | `.env.flows` |
| สคริปต์ + runbook + `flows.env.example` | `backups/flows/**` (runtime) |

## ข้อควรรู้

- บน dest ต้องมีสิทธิ์ `TRUNCATE` และ `SET session_replication_role` (user ใน Docker Postgres เริ่มต้นมักพอ)
- ไม่แตะตาราง Directus อื่น
- หลัง apply อาจต้อง reload/restart Directus ถ้า UI แคช flow เก่า
- Snapshot มี logic ของ flows — จำกัดสิทธิ์คนที่ push ได้ตามนโยบายทีม
