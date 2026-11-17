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
  "dest": { "databaseUrl": "postgresql://…@127.0.0.1:5432/bisinfo", "schema": "public" },
  "exportSchema": "public",
  "snapshotDir": "exports",
  "contentOnly": true,
  "pg": { "useDocker": false, "clientImage": "postgres:17-alpine", "dumpMinMajor": 17 }
}
```

| Field | ใช้ตอน |
|-------|--------|
| `source.*` | export |
| `dest.*` | compare / apply / restore |
| `exportSchema` | schema ใน SQL ที่ commit |

Override: `./scripts/sync.sh --config /path/to.json compare`

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
./scripts/sync.sh apply
./scripts/sync.sh apply --approve
./scripts/sync.sh backup
./scripts/sync.sh restore <YYYYMMDD_HHMMSS>
```

## Git hygiene

| Commit | Ignore |
|--------|--------|
| `exports/**`, `flows.config.example.json`, scripts, docs | `flows.config.json`, `backups/**` |
