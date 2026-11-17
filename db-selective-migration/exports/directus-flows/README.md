# Directus flows snapshot (committed)

This directory is the **portable source snapshot** for production sync.

- **Commit** the files here after `./scripts/db-flows-sync.sh export` (intentionally tracked).
- On the private prod server: `git pull`, configure `flows.config.json` (`dest` only), then `compare` / `apply` / `restore` — no live source DB and no SSH tunnel.
- Runtime backups stay under `backups/flows/` (gitignored). Secrets stay in `flows.config.json` (gitignored); template is `flows.config.example.json`.

See `docs/directus-flows-sync-runbook.md`.
