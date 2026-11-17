# Directus flows snapshot (committed)

Portable source snapshot for production sync inside `directus-flows-sync/`.

- **Commit** after `./scripts/sync.sh export`.
- On prod: `git pull`, set `dest` in `flows.config.json`, then `./scripts/sync.sh compare` / `apply` / `restore`.
- Runtime backups: `backups/` (gitignored).

See [docs/runbook.md](../docs/runbook.md).
