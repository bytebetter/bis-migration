#!/usr/bin/env bash

set -euo pipefail

# Regenerate baseline/bisinfo_selective_initial.sql from the source PostgreSQL pod.
# Uses credentials already present inside the pod (no local PGPASSWORD needed).
#
# Required env (defaults match bb-dev-cluster):
# - K8S_CONTEXT (default: bb-dev-cluster)
# - K8S_NAMESPACE (default: default)
# - POSTGRES_POD (default: postgresql-0)
# - SOURCE_DB (default: bisinfo_dev)
#
# Optional:
# - OUTPUT_PATH (default: package root/baseline/bisinfo_selective_initial.sql)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=db-selective-tables.inc.sh
source "${SCRIPT_DIR}/db-selective-tables.inc.sh"

K8S_CONTEXT="${K8S_CONTEXT:-bb-dev-cluster}"
K8S_NAMESPACE="${K8S_NAMESPACE:-default}"
POSTGRES_POD="${POSTGRES_POD:-postgresql-0}"
SOURCE_DB="${SOURCE_DB:-bisinfo_dev}"

REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT="${OUTPUT_PATH:-${REPO_ROOT}/baseline/bisinfo_selective_initial.sql}"

DIRECTUS_ARGS="$(join_pg_tables "${DIRECTUS_TABLES[@]}")"
BUSINESS_ARGS="$(join_pg_tables "${MIGRATE_TABLES[@]}")"

_q_db="$(printf '%q' "$SOURCE_DB")"

echo "Refreshing baseline from ${SOURCE_DB} (${K8S_CONTEXT}/${K8S_NAMESPACE}/${POSTGRES_POD})" >&2
echo "Output: ${OUT}" >&2

mkdir -p "$(dirname "$OUT")"

kubectl --context "$K8S_CONTEXT" -n "$K8S_NAMESPACE" exec -i "$POSTGRES_POD" -- bash -s <<EOF >"$OUT"
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
  ${DIRECTUS_ARGS} \\
  --exclude-table=public.directus_activity \\
  --exclude-table=public.directus_revisions \\
  ${BUSINESS_ARGS}
EOF

echo "Done. Size: $(du -h "$OUT" | cut -f1), lines: $(wc -l <"$OUT" | tr -d ' ')" >&2
