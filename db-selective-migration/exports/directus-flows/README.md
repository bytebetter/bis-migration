# Directus flows snapshot (committed)

This directory is the **portable source snapshot** for production sync.

- **Commit** the files here after `./scripts/db-flows-sync.sh export` (intentionally tracked).
- On the private prod server: `git pull`, then `compare` / `apply` / `restore` using **DEST only** — no live source DB and no SSH tunnel.
- Runtime backups stay under `backups/flows/` (gitignored).

See `docs/directus-flows-sync-runbook.md`.
