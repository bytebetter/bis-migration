# Directus flows sync (git-mediated, two machines)

ซิงก์เฉพาะ `directus_flows` + `directus_operations` โดย **ไม่ต้อง SSH** ไปหา prod:

1. เครื่องที่เข้าถึง **source** DB ได้ → `export` เป็นไฟล์ใน repo → **commit + push**
2. บน **private production server** → `git pull` → `compare` / `apply` / `restore` กับ Postgres ท้องถิ่น (`dest` เท่านั้น)

ใช้ DB dump/diff/apply ผ่าน `psql` / `pg_dump` ตามแนว selective migration — **ไม่ได้** พึ่ง `directus-extension-sync`

Connection settings อยู่ใน **JSON** (`flows.config.json`) ไม่ใช่ `.env`

## ไฟล์ที่เกี่ยวข้อง

| Path | Git? | บทบาท |
|------|------|--------|
| `exports/directus-flows/` | **commit** | snapshot จาก source (SQL + fingerprints) |
| `flows.config.example.json` | commit | เทมเพลต JSON config |
| `flows.config.json` | **ignore** | secrets จริง |
| `backups/flows/` | **ignore** | runtime backup ก่อน apply/restore |
| `scripts/db-flows-sync.sh` | commit | CLI |

## Config shape

คัดลอกแล้วแก้ค่าจริง:

```bash
cp flows.config.example.json flows.config.json
```

```json
{
  "source": {
    "databaseUrl": "postgresql://…",
    "schema": "bis_dev"
  },
  "dest": {
    "databaseUrl": "postgresql://bis:…@127.0.0.1:5432/bisinfo",
    "schema": "public"
  },
  "exportSchema": "public",
  "snapshotDir": "exports/directus-flows",
  "contentOnly": true,
  "pg": {
    "useDocker": false,
    "clientImage": "postgres:17-alpine",
    "dumpMinMajor": 17
  }
}
```

| Field | ใช้ตอน | หมายเหตุ |
|-------|--------|----------|
| `source.*` | export | Direct connection (`:5432`) แนะนำ; ไม่ต้องมีบน prod |
| `dest.*` | compare / apply / restore | Postgres ท้องถิ่นบน server |
| `exportSchema` | export | schema ใน SQL ที่ commit (มักเป็น `public`) |
| `snapshotDir` | ทุกคำสั่ง | default `exports/directus-flows` |
| `contentOnly` | compare | ไม่นับ `date_created` / `user_created` เมื่อ `true` |
| `pg.*` | optional | บังคับ Docker client / major ของ `pg_dump` |

Override path: `./scripts/db-flows-sync.sh --config /path/to.json compare`

## Stage A — Export (เครื่องที่ถึง source)

```bash
cd db-selective-migration
cp flows.config.example.json flows.config.json
# ใส่ source.databaseUrl + source.schema (+ exportSchema)
# dest ไม่จำเป็นในขั้นนี้

./scripts/db-flows-sync.sh export
```

เขียนลง `exports/directus-flows/`:

- `directus_flows_operations.sql` — data-only INSERTs (schema = `exportSchema`)
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

Server คุยกับ Postgres ของตัวเองได้โดยตรง — **ไม่ต้อง** `source` และ **ไม่ต้อง** SSH tunnel

```bash
cd /path/to/bis-migration/db-selective-migration
git pull

cp flows.config.example.json flows.config.json   # ครั้งแรก
# ใส่เฉพาะ dest.databaseUrl + dest.schema (เช่น 127.0.0.1:5432)
```

### Compare (default / dry-run)

เทียบ **committed snapshot** กับ dest สด — ไม่เขียน DB

```bash
./scripts/db-flows-sync.sh compare
```

สรุป **added / removed / changed**

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
| `exports/directus-flows/**` (snapshot ที่ export แล้ว) | `flows.config.json` |
| สคริปต์ + runbook + `flows.config.example.json` | `backups/flows/**` (runtime) |

## ข้อควรรู้

- บน dest ต้องมีสิทธิ์ `TRUNCATE` และ `SET session_replication_role` (user ใน Docker Postgres เริ่มต้นมักพอ)
- ไม่แตะตาราง Directus อื่น
- หลัง apply อาจต้อง reload/restart Directus ถ้า UI แคช flow เก่า
- Snapshot มี logic ของ flows — จำกัดสิทธิ์คนที่ push ได้ตามนโยบายทีม
