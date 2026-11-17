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

# on private prod:
git pull
./scripts/sync.sh compare         # needs dest only
./scripts/sync.sh apply           # type yes, or --approve
./scripts/sync.sh restore <stamp>
```

See [docs/runbook.md](docs/runbook.md).
