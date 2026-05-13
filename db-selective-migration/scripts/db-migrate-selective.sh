#!/usr/bin/env bash

set -euo pipefail

# Selective database migration:
# 1) copy full schema from source to target
# 2) copy data for directus* except heavy tables
# 3) copy data for explicit business tables
#
# Required env:
# - K8S_CONTEXT
# - K8S_NAMESPACE
# - POSTGRES_POD
# - DB_USER
# - PGPASSWORD
# - SOURCE_DB
# - TARGET_DB
#
# Optional env:
# - DROP_TARGET_IF_EXISTS=true|false (default: false)
# - VERIFY_ONLY=true|false (default: false)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=db-selective-tables.inc.sh
source "${SCRIPT_DIR}/db-selective-tables.inc.sh"

K8S_CONTEXT="${K8S_CONTEXT:?K8S_CONTEXT is required}"
K8S_NAMESPACE="${K8S_NAMESPACE:?K8S_NAMESPACE is required}"
POSTGRES_POD="${POSTGRES_POD:?POSTGRES_POD is required}"
DB_USER="${DB_USER:?DB_USER is required}"
PGPASSWORD="${PGPASSWORD:?PGPASSWORD is required}"
SOURCE_DB="${SOURCE_DB:?SOURCE_DB is required}"
TARGET_DB="${TARGET_DB:?TARGET_DB is required}"

DROP_TARGET_IF_EXISTS="${DROP_TARGET_IF_EXISTS:-false}"
VERIFY_ONLY="${VERIFY_ONLY:-false}"

function kexec() {
  kubectl --context "$K8S_CONTEXT" -n "$K8S_NAMESPACE" exec "$POSTGRES_POD" -- bash -lc "$1"
}

function verify_counts() {
  local mismatch=0
  local table=""

  for table in "${DIRECTUS_TABLES[@]}" "${MIGRATE_TABLES[@]}"; do
    local src
    local dst
    src="$(kexec "export PGPASSWORD='$PGPASSWORD'; psql -U '$DB_USER' -d '$SOURCE_DB' -tAc \"SELECT COUNT(1) FROM public.${table}\"")"
    dst="$(kexec "export PGPASSWORD='$PGPASSWORD'; psql -U '$DB_USER' -d '$TARGET_DB' -tAc \"SELECT COUNT(1) FROM public.${table}\"")"
    src="$(echo "$src" | tr -d '[:space:]')"
    dst="$(echo "$dst" | tr -d '[:space:]')"
    if [[ "$src" != "$dst" ]]; then
      echo "MISMATCH ${table}: source=${src} target=${dst}"
      mismatch=1
    fi
  done

  local activity_count
  local revisions_count
  activity_count="$(kexec "export PGPASSWORD='$PGPASSWORD'; psql -U '$DB_USER' -d '$TARGET_DB' -tAc \"SELECT COUNT(1) FROM public.directus_activity\" | tr -d '[:space:]'")"
  revisions_count="$(kexec "export PGPASSWORD='$PGPASSWORD'; psql -U '$DB_USER' -d '$TARGET_DB' -tAc \"SELECT COUNT(1) FROM public.directus_revisions\" | tr -d '[:space:]'")"
  echo "directus_activity (expected 0): ${activity_count}"
  echo "directus_revisions (expected 0): ${revisions_count}"

  if [[ "$mismatch" -ne 0 ]]; then
    return 1
  fi
}

if [[ "$VERIFY_ONLY" == "true" ]]; then
  verify_counts
  echo "Verification complete."
  exit 0
fi

echo "Preparing target database: ${TARGET_DB}"
kexec "set -euo pipefail; export PGPASSWORD='$PGPASSWORD'; \
  if [[ '$DROP_TARGET_IF_EXISTS' == 'true' ]]; then \
    psql -U '$DB_USER' -d postgres -v ON_ERROR_STOP=1 <<'SQL'; \
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${TARGET_DB}' AND pid <> pg_backend_pid(); \
DROP DATABASE IF EXISTS ${TARGET_DB}; \
SQL
  fi; \
  if [[ \"\$(psql -U '$DB_USER' -d postgres -tAc \"SELECT 1 FROM pg_database WHERE datname='${TARGET_DB}'\" | tr -d '[:space:]')\" != \"1\" ]]; then \
    psql -U '$DB_USER' -d postgres -v ON_ERROR_STOP=1 -c \"CREATE DATABASE ${TARGET_DB}\"; \
  fi"

echo "Copying schema from ${SOURCE_DB} -> ${TARGET_DB}"
kexec "set -euo pipefail; export PGPASSWORD='$PGPASSWORD'; \
  pg_dump -U '$DB_USER' -d '$SOURCE_DB' --schema-only --no-owner --no-privileges \
  | psql -U '$DB_USER' -d '$TARGET_DB' -v ON_ERROR_STOP=1"

DIRECTUS_ARGS="$(join_pg_tables "${DIRECTUS_TABLES[@]}")"
BUSINESS_ARGS="$(join_pg_tables "${MIGRATE_TABLES[@]}")"

echo "Copying selected data from ${SOURCE_DB} -> ${TARGET_DB}"
kexec "set -euo pipefail; export PGPASSWORD='$PGPASSWORD'; \
  pg_dump -U '$DB_USER' -d '$SOURCE_DB' --data-only --no-owner --no-privileges \
    ${DIRECTUS_ARGS} \
    --exclude-table=public.directus_activity \
    --exclude-table=public.directus_revisions \
    ${BUSINESS_ARGS} \
  | psql -U '$DB_USER' -d '$TARGET_DB' -v ON_ERROR_STOP=1"

echo "Running verification checks"
verify_counts
echo "Migration successful."
