# Selective DB Migration Runbook

This runbook migrates:

- full schema
- data for listed `directus_*` tables (see `scripts/db-selective-tables.inc.sh`) except:
  - `directus_activity`
  - `directus_revisions`
- data for business whitelist tables configured in `scripts/db-selective-tables.inc.sh` (used by migrate and dump scripts)

Run all commands from the **root of this package** (the folder that contains `scripts/` and `docs/`).  
If this folder lives inside [bis-migration](https://github.com/bytebetter/bis-migration), run `cd db-selective-migration` from the repository root first.

## Prerequisites

- Access to Kubernetes context and namespace containing PostgreSQL pod
- PostgreSQL role with create database permission (or pre-created target DB)
- `kubectl` configured locally

## Environment Variables

```bash
export K8S_CONTEXT="bb-dev-cluster"
export K8S_NAMESPACE="default"
export POSTGRES_POD="postgresql-0"
export DB_USER="devuser"
export PGPASSWORD="<postgres-password>"
export SOURCE_DB="bisinfo_dev"
export TARGET_DB="bisinfo_dev_clone2"
```

Optional:

```bash
export DROP_TARGET_IF_EXISTS="true"   # default false
export VERIFY_ONLY="false"            # default false
```

## Run Migration

```bash
./scripts/db-migrate-selective.sh
```

## Export backup file (for restore on production)

Run this against the **PostgreSQL instance that is the source of truth** for the cutover (for example a read replica or the live primary during a maintenance window), from a machine that has `kubectl` access.

From a machine with `kubectl` access to the source cluster, writes a single `.sql` under `backups/` (ignored by git in this package):

```bash
export K8S_CONTEXT="bb-dev-cluster"
export K8S_NAMESPACE="default"
export POSTGRES_POD="postgresql-0"
export DB_USER="devuser"
export PGPASSWORD="<postgres-password>"
export SOURCE_DB="bisinfo_dev"
# optional: OUTPUT_PATH=/path/to/dump.sql
# optional: COMPRESS=true
./scripts/db-dump-selective-backup.sh
```

Restore on production (empty database, same major PostgreSQL version recommended):

```bash
psql -U <admin> -d <new_database> -v ON_ERROR_STOP=1 -f bisinfo_selective_....sql
```

The dump is produced by PostgreSQL 16 `pg_dump` and may contain `\restrict` / `\unrestrict` markers for `psql`. Use a **PostgreSQL 16 or newer** `psql` client when restoring, or the script may fail on older clients.

If you used `COMPRESS=true`, restore with:

```bash
gunzip -c bisinfo_selective_....sql.gz | psql -U <admin> -d <new_database> -v ON_ERROR_STOP=1
```

## Verify Only Mode

```bash
VERIFY_ONLY=true ./scripts/db-migrate-selective.sh
```

## Swap Databases (Cutover Pattern)

After validating target DB:

1. terminate active connections to old clone DB
2. drop old clone DB
3. rename new DB to final name

Example:

```sql
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname IN ('bisinfo_dev_clone', 'bisinfo_dev_clone2')
  AND pid <> pg_backend_pid();

DROP DATABASE IF EXISTS bisinfo_dev_clone;
ALTER DATABASE bisinfo_dev_clone2 RENAME TO bisinfo_dev_clone;
```

## Production Notes

- Run during low write traffic if possible.
- Keep a rollback DB snapshot before cutover.
- If counts mismatch, do not cutover.
- `directus_activity` and `directus_revisions` are intentionally left empty.
