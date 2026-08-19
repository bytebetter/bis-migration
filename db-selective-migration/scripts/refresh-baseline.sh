#!/usr/bin/env bash

set -euo pipefail

# Regenerate baseline/bisinfo_selective_initial.sql from the source database.
#
# Preferred (Supabase / remote Postgres):
# - SOURCE_DATABASE_URL or DATABASE_URL
#   Use the Direct connection (db.<ref>.supabase.co:5432), not transaction pooler :6543
#
# Fallback (Kubernetes pod, previous workflow):
# - K8S_CONTEXT (default: bb-dev-cluster)
# - K8S_NAMESPACE (default: default)
# - POSTGRES_POD (default: postgresql-0)
# - SOURCE_DB (default: bisinfo_dev)
#
# Optional:
# - SOURCE_SCHEMA (default: public) — Supabase dev uses bis_dev
# - TARGET_SCHEMA (default: public) — prod restore schema
# - OUTPUT_PATH (default: package root/baseline/bisinfo_selective_initial.sql)
# - SQL_DATA_FORMAT=copy|inserts (default: copy; use inserts for TablePlus Execute SQL)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=db-selective-tables.inc.sh
source "${SCRIPT_DIR}/db-selective-tables.inc.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT="${OUTPUT_PATH:-${REPO_ROOT}/baseline/bisinfo_selective_initial.sql}"

SOURCE_SCHEMA="${SOURCE_SCHEMA:-public}"
TARGET_SCHEMA="${TARGET_SCHEMA:-public}"
DATA_FORMAT_ARGS="$(pg_dump_data_format_args)"
SOURCE_URL="$(resolved_source_database_url)"

echo "Output: ${OUT} (SQL_DATA_FORMAT=${SQL_DATA_FORMAT:-copy}, schema ${SOURCE_SCHEMA} → ${TARGET_SCHEMA})" >&2
mkdir -p "$(dirname "$OUT")"

if [[ -n "$SOURCE_URL" ]]; then
  echo "Refreshing baseline from SOURCE_DATABASE_URL" >&2
  dump_selective_from_url "$SOURCE_URL" | post_process_dump_sql >"$OUT"
else
  K8S_CONTEXT="${K8S_CONTEXT:-bb-dev-cluster}"
  K8S_NAMESPACE="${K8S_NAMESPACE:-default}"
  POSTGRES_POD="${POSTGRES_POD:-postgresql-0}"
  SOURCE_DB="${SOURCE_DB:-bisinfo_dev}"
  _q_db="$(printf '%q' "$SOURCE_DB")"
  DIRECTUS_ARGS="$(join_pg_tables "${DIRECTUS_TABLES[@]}")"
  BUSINESS_ARGS="$(join_pg_tables "${MIGRATE_TABLES[@]}")"

  echo "Refreshing baseline from ${SOURCE_DB} (${K8S_CONTEXT}/${K8S_NAMESPACE}/${POSTGRES_POD})" >&2

  kubectl --context "$K8S_CONTEXT" -n "$K8S_NAMESPACE" exec -i "$POSTGRES_POD" -- bash -s <<EOF | post_process_dump_sql >"$OUT"
set -euo pipefail
export PGPASSWORD="\$POSTGRES_PASSWORD"
cat <<'HDR'
-- selective DB backup (schema + partial data)
-- schema: full (no owner/privileges)
-- data: listed directus tables except directus_activity, directus_revisions + business whitelist
-- Restore: create empty DB, then psql -v ON_ERROR_STOP=1 -f this_file.sql
HDR
pg_dump -U "\$POSTGRES_USER" -d ${_q_db} --schema-only --no-owner --no-privileges
pg_dump -U "\$POSTGRES_USER" -d ${_q_db} --data-only --no-owner --no-privileges \\
  ${DATA_FORMAT_ARGS} \\
  ${DIRECTUS_ARGS} \\
  --exclude-table=public.directus_activity \\
  --exclude-table=public.directus_revisions \\
  ${BUSINESS_ARGS}
EOF
fi

echo "Done. Size: $(du -h "$OUT" | cut -f1), lines: $(wc -l <"$OUT" | tr -d ' ')" >&2
