#!/usr/bin/env bash

set -euo pipefail

# Stream a single plain-SQL backup from the PostgreSQL pod to a local file.
# Same content rules as scripts/db-migrate-selective.sh (see db-selective-tables.inc.sh).
#
# Required env:
# - K8S_CONTEXT, K8S_NAMESPACE, POSTGRES_POD
# - DB_USER, PGPASSWORD, SOURCE_DB
#
# Optional:
# - OUTPUT_PATH (default: package root/backups/bisinfo_selective_YYYYMMDD_HHMMSS.sql)
# - COMPRESS=true|false (default: false) — output .sql.gz when true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=db-selective-tables.inc.sh
source "${SCRIPT_DIR}/db-selective-tables.inc.sh"

K8S_CONTEXT="${K8S_CONTEXT:?K8S_CONTEXT is required}"
K8S_NAMESPACE="${K8S_NAMESPACE:?K8S_NAMESPACE is required}"
POSTGRES_POD="${POSTGRES_POD:?POSTGRES_POD is required}"
DB_USER="${DB_USER:?DB_USER is required}"
PGPASSWORD="${PGPASSWORD:?PGPASSWORD is required}"
SOURCE_DB="${SOURCE_DB:?SOURCE_DB is required}"

REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPRESS="${COMPRESS:-false}"
if [[ -n "${OUTPUT_PATH:-}" ]]; then
  OUT="${OUTPUT_PATH}"
else
  OUT="${REPO_ROOT}/backups/bisinfo_selective_$(date +%Y%m%d_%H%M%S).sql"
fi

DIRECTUS_ARGS="$(join_pg_tables "${DIRECTUS_TABLES[@]}")"
BUSINESS_ARGS="$(join_pg_tables "${MIGRATE_TABLES[@]}")"

mkdir -p "$(dirname "$OUT")"

if [[ "$COMPRESS" == "true" ]] && [[ "$OUT" != *.gz ]]; then
  OUT="${OUT}.gz"
fi

echo "Writing backup to: ${OUT}" >&2

_q_user="$(printf '%q' "$DB_USER")"
_q_db="$(printf '%q' "$SOURCE_DB")"

dump_stream() {
  kubectl --context "$K8S_CONTEXT" -n "$K8S_NAMESPACE" exec -i "$POSTGRES_POD" -- \
    env "PGPASSWORD=${PGPASSWORD}" bash -s <<EOF
set -euo pipefail
cat <<'HDR'
-- selective DB backup (schema + partial data)
-- schema: full (no owner/privileges)
-- data: listed directus tables except directus_activity, directus_revisions + business whitelist
-- Restore: create empty DB, then psql -v ON_ERROR_STOP=1 -f this_file.sql
HDR
pg_dump -U ${_q_user} -d ${_q_db} --schema-only --no-owner --no-privileges
pg_dump -U ${_q_user} -d ${_q_db} --data-only --no-owner --no-privileges \\
  ${DIRECTUS_ARGS} \\
  --exclude-table=public.directus_activity \\
  --exclude-table=public.directus_revisions \\
  ${BUSINESS_ARGS}
EOF
}

if [[ "$COMPRESS" == "true" ]]; then
  dump_stream | sed -E '/^\\restrict /d; /^\\unrestrict /d' | gzip -c >"$OUT"
else
  dump_stream | sed -E '/^\\restrict /d; /^\\unrestrict /d' >"$OUT"
fi

echo "Done. Size: $(du -h "$OUT" | cut -f1)" >&2
