#!/usr/bin/env bash

set -euo pipefail

# Check which whitelist tables exist on the source database (Supabase / remote URL or k8s pod).
#
# Supabase:
#   set -a && source .env.supabase && set +a
#   ./scripts/check-selective-tables.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=db-selective-tables.inc.sh
source "${SCRIPT_DIR}/db-selective-tables.inc.sh"

SOURCE_URL="$(resolved_source_database_url)"
SOURCE_SCHEMA="${SOURCE_SCHEMA:-public}"
TARGET_SCHEMA="${TARGET_SCHEMA:-public}"

table_exists() {
  local schema="$1"
  local table="$2"
  local found
  if [[ -n "$SOURCE_URL" ]]; then
    found="$(run_psql_remote "$SOURCE_URL" -tAc \
      "SELECT 1 FROM pg_tables WHERE schemaname='${schema}' AND tablename='${table}'" 2>/dev/null | tr -d '[:space:]')"
  else
    K8S_CONTEXT="${K8S_CONTEXT:-bb-dev-cluster}"
    K8S_NAMESPACE="${K8S_NAMESPACE:-default}"
    POSTGRES_POD="${POSTGRES_POD:-postgresql-0}"
    SOURCE_DB="${SOURCE_DB:-bisinfo_dev}"
    found="$(kubectl --context "$K8S_CONTEXT" -n "$K8S_NAMESPACE" exec -i "$POSTGRES_POD" -- bash -s <<EOF 2>/dev/null | tr -d '[:space:]'
set -euo pipefail
export PGPASSWORD="\$POSTGRES_PASSWORD"
psql -U "\$POSTGRES_USER" -d ${SOURCE_DB} -tAc "SELECT 1 FROM pg_tables WHERE schemaname='${schema}' AND tablename='${table}'"
EOF
)"
  fi
  [[ "$found" == "1" ]]
}

check_group() {
  local label="$1"
  shift
  local -a tables=("$@")
  local t missing=0 found=0
  echo "=== ${label} (schema: ${SOURCE_SCHEMA}) ==="
  for t in "${tables[@]}"; do
    if table_exists "$SOURCE_SCHEMA" "$t"; then
      echo "  OK   ${SOURCE_SCHEMA}.${t}"
      found=$((found + 1))
    else
      echo "  MISS ${SOURCE_SCHEMA}.${t}"
      missing=$((missing + 1))
    fi
  done
  echo "  → ${found} found, ${missing} missing"
  echo ""
}

if [[ -n "$SOURCE_URL" ]]; then
  echo "Source: SOURCE_DATABASE_URL (remote)"
  echo "SOURCE_SCHEMA=${SOURCE_SCHEMA}  TARGET_SCHEMA=${TARGET_SCHEMA} (for dump rewrite)"
  report_schema_summary "$SOURCE_URL"
  echo ""
  run_psql_remote "$SOURCE_URL" -c \
    "SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2 LIMIT 30;" 2>/dev/null || true
  echo ""
else
  echo "Source: k8s pod ${POSTGRES_POD:-postgresql-0} / ${SOURCE_DB:-bisinfo_dev}"
  echo ""
fi

check_group "Directus tables" "${DIRECTUS_TABLES[@]}"
check_group "Business master tables" "${MIGRATE_TABLES[@]}"
