#!/usr/bin/env bash
# Shared table lists for selective DB migration / backup.
# shellcheck shell=bash

MIGRATE_TABLES=(
  locations
  holiday
  settings
  role_menu
  time_slot
  mobile_location
  patient_type
  pacs_riscode
  bx_code
  exam_reason
  referring_md
  location_surgery
  procedure_item
  nurse_work_statuses
  underlying_diseases
  bx_options
  bx_options_bx_options
  tab_exam_option
  tab_exam_option_tab_exam_option
  certificate_reason
  lab_list
  finance_cost
  tab_procedure_options
  tab_clinical_options
  tab_procedures_options
  tab_location_options
  tab_technique_options
  tab_result_options
  tab_recommendation_options
  tab_assessment_options
  payment_type
  donate_type
  lab_cost
  examination_cost
  procedure_cost
  exam_costs
  billing_discount
  billing_discount_exam_costs
  place
  donate_for
  beds
  role_menu_directus_policies
  role_menu_directus_roles
)

DIRECTUS_TABLES=(
  directus_access
  directus_collections
  directus_dashboards
  directus_extensions
  directus_fields
  directus_files
  directus_flows
  directus_folders
  directus_migrations
  directus_operations
  directus_panels
  directus_permissions
  directus_policies
  directus_presets
  directus_relations
  directus_roles
  directus_settings
  directus_shares
  directus_translations
  directus_users
  directus_versions
  directus_webhooks
)

# directus_activity
# directus_revisions
# directus_notifications
# directus_sessions
# directus_sync_id_map

join_pg_tables() {
  local schema="${SOURCE_SCHEMA:-public}"
  local out=""
  local item=""
  for item in "$@"; do
    out+=" --table=${schema}.${item}"
  done
  echo "$out"
}

# SQL_DATA_FORMAT=copy (default, fast restore via psql) | inserts (TablePlus / GUI clients)
pg_dump_data_format_args() {
  if [[ "${SQL_DATA_FORMAT:-copy}" == "inserts" ]]; then
    echo "--inserts"
  fi
}

strip_psql_meta_commands() {
  sed -E '/^\\restrict /d; /^\\unrestrict /d'
}

# Rewrite dump SQL so prod restore targets a different schema (e.g. bis_dev → public).
rewrite_sql_schema() {
  local from="$1"
  local to="$2"
  if [[ "$from" == "$to" ]]; then
    cat
    return
  fi
  sed -E \
    -e "/^CREATE SCHEMA ${from};$/d" \
    -e "/^ALTER SCHEMA ${from} OWNER TO/d" \
    -e "/^COMMENT ON SCHEMA ${from} /d" \
    -e "s/${from}\\./${to}./g" \
    -e "s/SCHEMA ${from}/SCHEMA ${to}/g"
}

post_process_dump_sql() {
  strip_psql_meta_commands | rewrite_sql_schema "${SOURCE_SCHEMA:-public}" "${TARGET_SCHEMA:-public}"
}

resolved_source_database_url() {
  if [[ -n "${SOURCE_DATABASE_URL:-}" ]]; then
    echo "${SOURCE_DATABASE_URL}"
  elif [[ -n "${DATABASE_URL:-}" ]]; then
    echo "${DATABASE_URL}"
  else
    echo ""
  fi
}

pg_dump_major_version() {
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "0"
    return
  fi
  pg_dump --version | sed -E 's/.*[^0-9]([0-9]+)\..*/\1/'
}

# Remote dumps (Supabase etc.) need pg_dump >= server major (Supabase is PG 17).
# Prefer Docker postgres:17 when local client is missing or too old.
run_pg_dump_remote() {
  local image="${PG_CLIENT_IMAGE:-postgres:17-alpine}"
  local min_major="${PG_DUMP_MIN_MAJOR:-17}"

  if [[ "${PG_USE_DOCKER:-}" != "true" ]] && command -v pg_dump >/dev/null 2>&1; then
    local ver
    ver="$(pg_dump_major_version)"
    if [[ "$ver" -ge "$min_major" ]]; then
      pg_dump "$@"
      return
    fi
    echo "Local pg_dump is ${ver}.x; need >= ${min_major} for this server. Using Docker (${image})..." >&2
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "Install pg_dump ${min_major}+ (brew install postgresql@${min_major}) or Docker." >&2
    return 1
  fi
  docker run --rm "$image" pg_dump "$@"
}

run_psql_remote() {
  local image="${PG_CLIENT_IMAGE:-postgres:17-alpine}"
  local min_major="${PG_DUMP_MIN_MAJOR:-17}"

  if [[ "${PG_USE_DOCKER:-}" != "true" ]] && command -v psql >/dev/null 2>&1; then
    local ver
    ver="$(pg_dump_major_version)"
    if [[ "$ver" -ge "$min_major" ]]; then
      psql "$@"
      return
    fi
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "Install psql ${min_major}+ or Docker." >&2
    return 1
  fi
  docker run --rm "$image" psql "$@"
}

# Print table names from argv that exist in SOURCE_SCHEMA (one per line).
filter_existing_tables() {
  local url="$1"
  local schema="${SOURCE_SCHEMA:-public}"
  shift
  local t found
  for t in "$@"; do
    found="$(run_psql_remote "$url" -tAc "SELECT 1 FROM pg_tables WHERE schemaname='${schema}' AND tablename='${t}'" 2>/dev/null | tr -d '[:space:]')"
    if [[ "$found" == "1" ]]; then
      echo "$t"
    else
      echo "WARN: skipping missing table ${schema}.${t}" >&2
    fi
  done
}

report_schema_summary() {
  local url="$1"
  local schema="${SOURCE_SCHEMA:-public}"
  local total directus_count
  total="$(run_psql_remote "$url" -tAc "SELECT COUNT(*) FROM pg_tables WHERE schemaname='${schema}'" 2>/dev/null | tr -d '[:space:]')"
  directus_count="$(run_psql_remote "$url" -tAc "SELECT COUNT(*) FROM pg_tables WHERE schemaname='${schema}' AND tablename LIKE 'directus_%'" 2>/dev/null | tr -d '[:space:]')"
  echo "Database has ${total:-?} table(s) in schema ${schema} (${directus_count:-?} directus_*)." >&2
}

# Bash 3.2 (macOS) has no mapfile — read lines into a named array variable.
read_lines_to_array() {
  local __arr="$1"
  shift
  local line
  eval "${__arr}=()"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    eval "${__arr}+=(\"\${line}\")"
  done
}

# Dump source schema + whitelist data from a Postgres URL (Supabase or any remote).
# Set SOURCE_SCHEMA (e.g. bis_dev) and TARGET_SCHEMA (e.g. public for prod restore).
dump_selective_from_url() {
  local url="$1"
  local schema="${SOURCE_SCHEMA:-public}"
  local target="${TARGET_SCHEMA:-public}"
  local directus_existing business_existing
  local directus_args business_args

  read_lines_to_array directus_existing < <(filter_existing_tables "$url" "${DIRECTUS_TABLES[@]}")
  read_lines_to_array business_existing < <(filter_existing_tables "$url" "${MIGRATE_TABLES[@]}")

  directus_args="$(join_pg_tables "${directus_existing[@]}")"
  business_args="$(join_pg_tables "${business_existing[@]}")"

  if [[ ${#directus_existing[@]} -eq 0 && ${#business_existing[@]} -eq 0 ]]; then
    report_schema_summary "$url"
    echo "ERROR: no whitelist tables found in schema ${schema}." >&2
    echo "Run: ./scripts/check-selective-tables.sh" >&2
    return 1
  fi

  echo "Data dump: ${#directus_existing[@]} directus table(s), ${#business_existing[@]} business table(s) from schema ${schema}" >&2
  if [[ "$schema" != "$target" ]]; then
    echo "Post-process: rewrite schema ${schema} → ${target} for prod restore" >&2
  fi

  cat <<HDR
-- selective DB backup (schema + partial data)
-- source schema: ${schema} → restore schema: ${target}
-- data: listed directus tables except directus_activity, directus_revisions + business whitelist
-- Restore: create empty DB, then psql -v ON_ERROR_STOP=1 -f this_file.sql
HDR
  run_pg_dump_remote --dbname="$url" --schema="$schema" --schema-only --no-owner --no-privileges
  # shellcheck disable=SC2086
  run_pg_dump_remote --dbname="$url" --data-only --no-owner --no-privileges \
    ${DATA_FORMAT_ARGS:-} \
    ${directus_args} \
    --exclude-table="${schema}.directus_activity" \
    --exclude-table="${schema}.directus_revisions" \
    ${business_args}
}

run_pg_dump() {
  if command -v pg_dump >/dev/null 2>&1; then
    pg_dump "$@"
  elif command -v docker >/dev/null 2>&1; then
    docker run --rm "${PG_CLIENT_IMAGE:-postgres:17-alpine}" pg_dump "$@"
  else
    echo "pg_dump not found. Install PostgreSQL client tools, or Docker." >&2
    return 1
  fi
}
