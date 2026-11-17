# Directus flows sync

Self-contained tooling to sync **Directus `directus_flows` + `directus_operations`** via a git-mediated snapshot (no SSH to prod).

## Layout

| Path | Git? | Role |
|------|------|------|
| `scripts/sync.sh` | commit | CLI |
| `scripts/db-flows-common.inc.sh` | commit | helpers (self-contained) |
| `flows.config.example.json` | commit | JSON config template |
| `flows.config.json` | **ignore** | secrets |
| `exports/` | **commit** | portable snapshot from source |
| `backups/` | **ignore** | runtime dest backups |
| `docs/runbook.md` | commit | full runbook |

## Quick start

```bash
cd directus-flows-sync
cp flows.config.example.json flows.config.json
# fill source.* (export machine) and/or dest.* (prod server)

./scripts/sync.sh export          # needs source
git add exports/ && git commit && git push

# on private prod (Postgres published on host :5432):
git pull
# prefer: "pg": { "useDocker": false } + dest URL @127.0.0.1:5432
# if Docker client: loopback is rewritten to host.docker.internal automatically
./scripts/sync.sh compare         # needs dest only
./scripts/sync.sh check-deps      # scan snapshot for collections/folders/URLs/… (optional dest probe)
./scripts/sync.sh apply           # type yes, or --approve
./scripts/sync.sh restore <stamp>
```

If compare fails with `Connection refused` to `127.0.0.1` while Postgres is in Docker, see [docs/runbook.md](docs/runbook.md#prod--postgres-ใน-docker-connection-refused).
