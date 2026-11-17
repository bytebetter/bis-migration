#!/usr/bin/env bash
# Shared helpers for Directus flows / operations sync.
# shellcheck shell=bash

SCRIPT_DIR_FLOWS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=db-selective-tables.inc.sh
source "${SCRIPT_DIR_FLOWS}/db-selective-tables.inc.sh"

FLOWS_PACKAGE_ROOT="$(cd "${SCRIPT_DIR_FLOWS}/.." && pwd)"
FLOWS_BACKUP_ROOT="${FLOWS_PACKAGE_ROOT}/backups/flows"

# Subset of DIRECTUS_TABLES — keep order: operations depend on flows (and vice versa via operation FK).
FLOW_SYNC_TABLES=(
  directus_flows
  directus_operations
)

_FLOWS_SSH_PID=""
_FLOWS_SSH_STARTED_BY_US=0

load_flows_env_file() {
  local env_file="${FLOWS_ENV_FILE:-${FLOWS_PACKAGE_ROOT}/.env.flows}"
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
}

resolved_dest_database_url() {
  if [[ -n "${DEST_DATABASE_URL:-}" ]]; then
    echo "${DEST_DATABASE_URL}"
  elif [[ -n "${TARGET_DATABASE_URL:-}" ]]; then
    echo "${TARGET_DATABASE_URL}"
  else
    echo ""
  fi
}

require_source_url() {
  local url
  url="$(resolved_source_database_url)"
  if [[ -z "$url" ]]; then
    echo "ERROR: set SOURCE_DATABASE_URL (or DATABASE_URL) in .env.flows / environment." >&2
    echo "See docker/flows.env.example" >&2
    return 1
  fi
  echo "$url"
}

require_dest_url() {
  local url
  url="$(resolved_dest_database_url)"
  if [[ -z "$url" ]]; then
    echo "ERROR: set DEST_DATABASE_URL in .env.flows / environment." >&2
    echo "See docker/flows.env.example" >&2
    return 1
  fi
  echo "$url"
}

flows_schema_for_side() {
  local side="$1"
  if [[ "$side" == "source" ]]; then
    echo "${SOURCE_SCHEMA:-public}"
  else
    echo "${DEST_SCHEMA:-${TARGET_SCHEMA:-public}}"
  fi
}

# Optional SSH local-forward for private production Postgres.
flows_ssh_tunnel_start() {
  if [[ -z "${DEST_SSH_HOST:-}" ]]; then
    return 0
  fi
  local local_port remote_host remote_port ssh_port identity_args=()
  local_port="${DEST_SSH_LOCAL_PORT:-15432}"
  remote_host="${DEST_SSH_REMOTE_HOST:-127.0.0.1}"
  remote_port="${DEST_SSH_REMOTE_PORT:-5432}"
  ssh_port="${DEST_SSH_PORT:-22}"

  if [[ -n "${DEST_SSH_IDENTITY_FILE:-}" ]]; then
    identity_args=(-i "${DEST_SSH_IDENTITY_FILE/#\~/$HOME}")
  fi

  if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$local_port" >/dev/null 2>&1; then
    echo "SSH tunnel: port ${local_port} already open (reusing)." >&2
    # Keep existing _FLOWS_SSH_STARTED_BY_US so EXIT trap still cleans up our tunnel.
    return 0
  fi

  echo "SSH tunnel: ${DEST_SSH_HOST} ${remote_host}:${remote_port} → 127.0.0.1:${local_port}" >&2
  ssh -f -N \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -p "$ssh_port" \
    "${identity_args[@]}" \
    -L "${local_port}:${remote_host}:${remote_port}" \
    "$DEST_SSH_HOST"
  # shellcheck disable=SC2009
  _FLOWS_SSH_PID="$(ps -Ao pid,command | awk -v p="$local_port" -v h="$DEST_SSH_HOST" '
    $0 ~ "ssh" && $0 ~ ("-L " p ":") && $0 ~ h { print $1; exit }
  ')"
  _FLOWS_SSH_STARTED_BY_US=1
  sleep 1
}

flows_ssh_tunnel_stop() {
  if [[ "${_FLOWS_SSH_STARTED_BY_US}" != "1" ]]; then
    return 0
  fi
  if [[ -n "${_FLOWS_SSH_PID}" ]] && kill -0 "${_FLOWS_SSH_PID}" 2>/dev/null; then
    echo "SSH tunnel: stopping pid ${_FLOWS_SSH_PID}" >&2
    kill "${_FLOWS_SSH_PID}" 2>/dev/null || true
  fi
  _FLOWS_SSH_PID=""
  _FLOWS_SSH_STARTED_BY_US=0
}

flows_cleanup_on_exit() {
  flows_ssh_tunnel_stop
}

# Prefer host psql for dest/localhost (SSH tunnels + Docker Desktop localhost quirks).
# Fall back to run_psql_remote (may use Docker) for remote URLs when local client is missing.
flows_psql() {
  local url="$1"
  shift
  if command -v psql >/dev/null 2>&1; then
    psql "$url" "$@"
    return
  fi
  run_psql_remote "$url" "$@"
}

# When default PATH has an old pg_dump and Docker is unavailable, prefer Homebrew PG 17+.
flows_prefer_modern_pg_dump() {
  local min_major="${PG_DUMP_MIN_MAJOR:-17}"
  local ver=0
  if command -v pg_dump >/dev/null 2>&1; then
    ver="$(pg_dump_major_version)"
    if [[ "$ver" -ge "$min_major" ]]; then
      return 0
    fi
  fi
  local d
  for d in \
    /opt/homebrew/opt/postgresql@17/bin \
    /usr/local/opt/postgresql@17/bin \
    /opt/homebrew/opt/postgresql@16/bin \
    /usr/local/opt/postgresql@16/bin
  do
    if [[ -x "${d}/pg_dump" ]]; then
      export PATH="${d}:${PATH}"
      ver="$(pg_dump_major_version)"
      if [[ "$ver" -ge "$min_major" ]]; then
        echo "Using pg_dump from ${d} (major ${ver})" >&2
        return 0
      fi
    fi
  done
  return 0
}

# Dump data-only SQL for flow tables from url/schema (stdout).
dump_flows_data_sql() {
  local url="$1"
  local schema="$2"
  local table_args
  flows_prefer_modern_pg_dump
  table_args="$(join_pg_tables_for_schema "$schema" "${FLOW_SYNC_TABLES[@]}")"
  # shellcheck disable=SC2086
  run_pg_dump_remote --dbname="$url" --data-only --no-owner --no-privileges \
    --column-inserts \
    ${table_args}
}

join_pg_tables_for_schema() {
  local schema="$1"
  shift
  local out="" item
  for item in "$@"; do
    out+=" --table=${schema}.${item}"
  done
  echo "$out"
}

# Rewrite dump schema names for restore into DEST_SCHEMA.
rewrite_flows_dump_schema() {
  local from="$1"
  local to="$2"
  if [[ "$from" == "$to" ]]; then
    cat
    return
  fi
  sed -E \
    -e "s/${from}\\./${to}./g" \
    -e "s/SCHEMA ${from}/SCHEMA ${to}/g"
}

# pg_dump 17 emits settings older Postgres (e.g. prod 16) reject.
sanitize_flows_dump_sql() {
  strip_psql_meta_commands | sed -E \
    -e '/^SET transaction_timeout =/d' \
    -e '/^SET idle_session_timeout =/d'
}

# Pipeline used for every backup/apply/export normalize step.
normalize_flows_dump_sql() {
  local from_schema="$1"
  local to_schema="$2"
  sanitize_flows_dump_sql | rewrite_flows_dump_schema "$from_schema" "$to_schema"
}

# Export a stable TSV fingerprint per row for compare (id + content fields).
# Columns chosen to ignore date_created / user_created noise when CONTENT_ONLY=true (default).
export_flows_fingerprint_tsv() {
  local url="$1"
  local schema="$2"
  local kind="$3" # flows | operations
  local content_only="${CONTENT_ONLY:-true}"

  if [[ "$kind" == "flows" ]]; then
    if [[ "$content_only" == "true" ]]; then
      flows_psql "$url" -v ON_ERROR_STOP=1 -AtF $'\t' -c "
SELECT id::text,
       coalesce(name,''),
       coalesce(icon,''),
       coalesce(color,''),
       coalesce(description,''),
       coalesce(status,''),
       coalesce(trigger,''),
       coalesce(accountability,''),
       coalesce(options::text,''),
       coalesce(operation::text,'')
FROM ${schema}.directus_flows
ORDER BY id;"
    else
      flows_psql "$url" -v ON_ERROR_STOP=1 -AtF $'\t' -c "
SELECT id::text,
       coalesce(name,''),
       coalesce(icon,''),
       coalesce(color,''),
       coalesce(description,''),
       coalesce(status,''),
       coalesce(trigger,''),
       coalesce(accountability,''),
       coalesce(options::text,''),
       coalesce(operation::text,''),
       coalesce(date_created::text,''),
       coalesce(user_created::text,'')
FROM ${schema}.directus_flows
ORDER BY id;"
    fi
  else
    if [[ "$content_only" == "true" ]]; then
      flows_psql "$url" -v ON_ERROR_STOP=1 -AtF $'\t' -c "
SELECT id::text,
       coalesce(name,''),
       coalesce(key,''),
       coalesce(type,''),
       position_x::text,
       position_y::text,
       coalesce(options::text,''),
       coalesce(resolve::text,''),
       coalesce(reject::text,''),
       flow::text
FROM ${schema}.directus_operations
ORDER BY id;"
    else
      flows_psql "$url" -v ON_ERROR_STOP=1 -AtF $'\t' -c "
SELECT id::text,
       coalesce(name,''),
       coalesce(key,''),
       coalesce(type,''),
       position_x::text,
       position_y::text,
       coalesce(options::text,''),
       coalesce(resolve::text,''),
       coalesce(reject::text,''),
       flow::text,
       coalesce(date_created::text,''),
       coalesce(user_created::text,'')
FROM ${schema}.directus_operations
ORDER BY id;"
    fi
  fi
}

# Human-readable name map: id → name (flows) or id → key (operations)
export_flows_label_map() {
  local url="$1"
  local schema="$2"
  local kind="$3"
  if [[ "$kind" == "flows" ]]; then
    flows_psql "$url" -v ON_ERROR_STOP=1 -AtF $'\t' -c "
SELECT id::text, coalesce(name,'') FROM ${schema}.directus_flows ORDER BY id;"
  else
    flows_psql "$url" -v ON_ERROR_STOP=1 -AtF $'\t' -c "
SELECT id::text, coalesce(name, key, id::text) FROM ${schema}.directus_operations ORDER BY id;"
  fi
}

compare_fingerprint_files() {
  local kind="$1"
  local src_file="$2"
  local dst_file="$3"
  local src_labels="$4"
  local dst_labels="$5"
  python3 - "$kind" "$src_file" "$dst_file" "$src_labels" "$dst_labels" <<'PY'
import sys
from pathlib import Path

kind, src_path, dst_path, src_labels_path, dst_labels_path = sys.argv[1:6]

def load_rows(path):
    rows = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        rows[parts[0]] = "\t".join(parts[1:])
    return rows

def load_labels(path):
    labels = {}
    p = Path(path)
    if not p.exists():
        return labels
    for line in p.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rid, name = line.split("\t", 1)
        labels[rid] = name
    return labels

src = load_rows(src_path)
dst = load_rows(dst_path)
src_labels = load_labels(src_labels_path)
dst_labels = load_labels(dst_labels_path)

added = sorted(set(src) - set(dst))
removed = sorted(set(dst) - set(src))
changed = sorted(i for i in (set(src) & set(dst)) if src[i] != dst[i])
unchanged = len(set(src) & set(dst)) - len(changed)

def label(rid):
    return src_labels.get(rid) or dst_labels.get(rid) or ""

print(f"=== {kind.upper()} ===")
print(f"  source: {len(src)}  dest: {len(dst)}  unchanged: {unchanged}")
print(f"  + added (source only):   {len(added)}")
print(f"  - removed (dest only):   {len(removed)}")
print(f"  ~ changed:               {len(changed)}")

def show(title, ids, mark):
    if not ids:
        return
    print(f"  {title}")
    for rid in ids[:40]:
        name = label(rid)
        suffix = f"  {name}" if name else ""
        print(f"    {mark} {rid}{suffix}")
    if len(ids) > 40:
        print(f"    … {len(ids) - 40} more")

show("Added:", added, "+")
show("Removed:", removed, "-")
show("Changed:", changed, "~")

# exit 1 when differences exist (useful for CI / scripting)
sys.exit(0 if not (added or removed or changed) else 1)
PY
}

backup_dest_flows() {
  local dest_url="$1"
  local dest_schema="$2"
  local stamp="${3:-$(date +%Y%m%d_%H%M%S)}"
  local dir="${FLOWS_BACKUP_ROOT}/${stamp}"
  mkdir -p "$dir"

  echo "Backing up dest flows → ${dir}" >&2
  dump_flows_data_sql "$dest_url" "$dest_schema" \
    | normalize_flows_dump_sql "$dest_schema" "$dest_schema" \
    >"${dir}/directus_flows_operations.sql"

  flows_psql "$dest_url" -v ON_ERROR_STOP=1 -Atc \
    "SELECT count(*) FROM ${dest_schema}.directus_flows;" >"${dir}/counts_flows.txt" || true
  flows_psql "$dest_url" -v ON_ERROR_STOP=1 -Atc \
    "SELECT count(*) FROM ${dest_schema}.directus_operations;" >"${dir}/counts_operations.txt" || true

  cat >"${dir}/README.txt" <<EOF
Directus flows backup
created: ${stamp}
dest_schema: ${dest_schema}
files:
  directus_flows_operations.sql  — data-only dump (column-inserts)
  counts_flows.txt / counts_operations.txt — row counts at backup time

Restore:
  ./scripts/db-flows-sync.sh restore ${stamp}
EOF

  echo "$dir"
}

# Replace dest flow tables with source data (FK-safe via session_replication_role).
apply_flows_from_source() {
  local source_url="$1"
  local source_schema="$2"
  local dest_url="$3"
  local dest_schema="$4"
  local tmp
  tmp="$(mktemp -t bis-flows-apply.XXXXXX.sql)"

  {
    echo "BEGIN;"
    echo "SET LOCAL session_replication_role = replica;"
    echo "TRUNCATE TABLE ${dest_schema}.directus_operations, ${dest_schema}.directus_flows CASCADE;"
  } >"$tmp"

  dump_flows_data_sql "$source_url" "$source_schema" \
    | normalize_flows_dump_sql "$source_schema" "$dest_schema" \
    >>"$tmp"

  {
    echo "SET LOCAL session_replication_role = origin;"
    echo "COMMIT;"
  } >>"$tmp"

  echo "Applying source flows/operations → dest (${source_schema} → ${dest_schema})…" >&2
  flows_psql "$dest_url" -v ON_ERROR_STOP=1 -f - <"$tmp"
  rm -f "$tmp"
}

restore_flows_from_backup() {
  local dest_url="$1"
  local dest_schema="$2"
  local backup_dir="$3"
  local sql_file="${backup_dir}/directus_flows_operations.sql"
  local tmp

  if [[ ! -f "$sql_file" ]]; then
    echo "ERROR: missing ${sql_file}" >&2
    return 1
  fi

  tmp="$(mktemp -t bis-flows-restore.XXXXXX.sql)"
  {
    echo "BEGIN;"
    echo "SET LOCAL session_replication_role = replica;"
    echo "TRUNCATE TABLE ${dest_schema}.directus_operations, ${dest_schema}.directus_flows CASCADE;"
    cat "$sql_file"
    echo "SET LOCAL session_replication_role = origin;"
    echo "COMMIT;"
  } >"$tmp"

  echo "Restoring flows from ${backup_dir} → ${dest_schema}…" >&2
  flows_psql "$dest_url" -v ON_ERROR_STOP=1 -f - <"$tmp"
  rm -f "$tmp"
}

resolve_backup_dir() {
  local name="$1"
  if [[ -d "$name" ]]; then
    echo "$name"
    return 0
  fi
  if [[ -d "${FLOWS_BACKUP_ROOT}/${name}" ]]; then
    echo "${FLOWS_BACKUP_ROOT}/${name}"
    return 0
  fi
  echo "ERROR: backup not found: ${name}" >&2
  echo "Looked in: ${name} and ${FLOWS_BACKUP_ROOT}/${name}" >&2
  return 1
}
