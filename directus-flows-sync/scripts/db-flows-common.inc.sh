#!/usr/bin/env bash
# Shared helpers for Directus flows / operations sync (git-mediated snapshot workflow).
# Self-contained package under directus-flows-sync/ (vendors minimal pg_dump/psql helpers).
# shellcheck shell=bash

SCRIPT_DIR_FLOWS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLOWS_PACKAGE_ROOT="$(cd "${SCRIPT_DIR_FLOWS}/.." && pwd)"
FLOWS_BACKUP_ROOT="${FLOWS_PACKAGE_ROOT}/backups"
# Committed source-of-truth snapshot for prod compare/apply (see exports/README.md).
FLOWS_SNAPSHOT_DEFAULT="${FLOWS_PACKAGE_ROOT}/exports"

FLOW_SYNC_TABLES=(
  directus_flows
  directus_operations
)

# ── Vendored Postgres client helpers (formerly selective-migration) ─────────

resolved_source_database_url() {
  if [[ -n "${SOURCE_DATABASE_URL:-}" ]]; then
    echo "${SOURCE_DATABASE_URL}"
  elif [[ -n "${DATABASE_URL:-}" ]]; then
    echo "${DATABASE_URL}"
  else
    echo ""
  fi
}

strip_psql_meta_commands() {
  sed -E '/^\\restrict /d; /^\\unrestrict /d'
}

pg_dump_major_version() {
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "0"
    return
  fi
  pg_dump --version | sed -E 's/.*[^0-9]([0-9]+)\..*/\1/'
}

# Parse postgres URL host with urllib (handles passwords containing '@' when %-encoded).
flows_url_host() {
  local url="$1"
  python3 - "$url" <<'PY'
import sys
from urllib.parse import urlparse, unquote
u = urlparse(sys.argv[1])
print(u.hostname or "")
PY
}

flows_url_is_loopback() {
  local host
  host="$(flows_url_host "$1")"
  case "$host" in
    127.0.0.1|localhost|::1|0.0.0.0) return 0 ;;
    *) return 1 ;;
  esac
}

# Warn when password likely broke host parsing (unescaped '@' in userinfo).
flows_warn_url_password_encoding() {
  local url="$1"
  python3 - "$url" <<'PY' >&2 || true
import sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
raw = sys.argv[1]
# Heuristic: more than one '@' before the path → password probably not %-encoded.
before = raw.split("://", 1)[-1].split("/", 1)[0]
if before.count("@") > 1:
    print(
        "WARN: database URL has multiple '@' before '/'. "
        "If the password contains '@', encode it as %40 "
        "(e.g. postgresql://user:p%40ss@127.0.0.1:5432/db).",
        file=sys.stderr,
    )
if u.hostname in (None, ""):
    print("WARN: could not parse hostname from database URL.", file=sys.stderr)
PY
}

# Inside a client container, 127.0.0.1 is the container — rewrite to reach host-published Postgres.
flows_rewrite_url_for_docker_client() {
  local url="$1"
  local docker_host="${PG_DOCKER_HOST:-host.docker.internal}"
  python3 - "$url" "$docker_host" <<'PY'
import sys
from urllib.parse import quote, unquote, urlparse, urlunparse

url, docker_host = sys.argv[1], sys.argv[2]
u = urlparse(url)
host = u.hostname or ""
if host in ("127.0.0.1", "localhost", "::1", "0.0.0.0"):
    userinfo = ""
    if u.username is not None:
        userinfo = quote(unquote(u.username), safe="")
        if u.password is not None:
            # unquote first so already-%40 passwords are not double-encoded.
            userinfo += ":" + quote(unquote(u.password), safe="")
        userinfo += "@"
    port = f":{u.port}" if u.port else ""
    netloc = f"{userinfo}{docker_host}{port}"
    print(urlunparse((u.scheme, netloc, u.path, u.params, u.query, u.fragment)))
else:
    print(url)
PY
}

flows_docker_run_args() {
  # Always map host.docker.internal for loopback URLs; optionally join a compose network too.
  local args=(--add-host=host.docker.internal:host-gateway)
  if [[ -n "${PG_DOCKER_NETWORK:-}" ]]; then
    args+=(--network "${PG_DOCKER_NETWORK}")
  fi
  printf '%s\n' "${args[@]}"
}

# Run psql in a throwaway client container that can reach host-mapped or compose-network Postgres.
flows_psql_docker() {
  local url="$1"
  shift
  local image="${PG_CLIENT_IMAGE:-postgres:17-alpine}"
  local docker_url run_args=()
  local line

  if ! command -v docker >/dev/null 2>&1; then
    echo "Install Docker or host psql to connect." >&2
    return 1
  fi

  flows_warn_url_password_encoding "$url"
  docker_url="$(flows_rewrite_url_for_docker_client "$url")"
  if [[ "$docker_url" != "$url" ]]; then
    echo "Docker psql client: rewriting loopback host → ${PG_DOCKER_HOST:-host.docker.internal}" >&2
  fi
  while IFS= read -r line; do
    [[ -n "$line" ]] && run_args+=("$line")
  done < <(flows_docker_run_args)

  # shellcheck disable=SC2086
  docker run --rm "${run_args[@]}" "$image" psql "$docker_url" "$@"
}

flows_pg_dump_docker() {
  local image="${PG_CLIENT_IMAGE:-postgres:17-alpine}"
  local run_args=() line
  local -a dump_args=("$@")
  local i dbname="" rewritten

  if ! command -v docker >/dev/null 2>&1; then
    echo "Install Docker or host pg_dump." >&2
    return 1
  fi

  for i in "${!dump_args[@]}"; do
    case "${dump_args[$i]}" in
      --dbname=*)
        dbname="${dump_args[$i]#--dbname=}"
        flows_warn_url_password_encoding "$dbname"
        rewritten="$(flows_rewrite_url_for_docker_client "$dbname")"
        if [[ "$rewritten" != "$dbname" ]]; then
          echo "Docker pg_dump client: rewriting loopback host → ${PG_DOCKER_HOST:-host.docker.internal}" >&2
        fi
        dump_args[$i]="--dbname=${rewritten}"
        ;;
    esac
  done

  while IFS= read -r line; do
    [[ -n "$line" ]] && run_args+=("$line")
  done < <(flows_docker_run_args)

  docker run --rm "${run_args[@]}" "$image" pg_dump "${dump_args[@]}"
}

run_pg_dump_remote() {
  local image="${PG_CLIENT_IMAGE:-postgres:17-alpine}"
  local min_major="${PG_DUMP_MIN_MAJOR:-17}"
  local use_docker=0
  local dbname=""
  local a

  for a in "$@"; do
    case "$a" in
      --dbname=*) dbname="${a#--dbname=}" ;;
    esac
  done

  if [[ "${PG_USE_DOCKER:-}" == "true" ]]; then
    use_docker=1
  elif command -v pg_dump >/dev/null 2>&1; then
    local ver
    ver="$(pg_dump_major_version)"
    if [[ "$ver" -ge "$min_major" ]]; then
      # Host pg_dump can use 127.0.0.1 when Postgres is published on the host.
      pg_dump "$@"
      return
    fi
    echo "Local pg_dump is ${ver}.x; need >= ${min_major}. Using Docker (${image})..." >&2
    use_docker=1
  else
    use_docker=1
  fi

  if [[ "$use_docker" -eq 1 ]]; then
    flows_pg_dump_docker "$@"
    return
  fi
  echo "Install pg_dump ${min_major}+ or Docker." >&2
  return 1
}

run_psql_remote() {
  # Prefer host psql for published ports (ignore client major — queries don't need dump parity).
  if [[ "${PG_USE_DOCKER:-}" != "true" ]] && command -v psql >/dev/null 2>&1; then
    local url="${1:-}"
    if [[ -n "$url" ]]; then
      flows_warn_url_password_encoding "$url"
    fi
    psql "$@"
    return
  fi
  flows_psql_docker "$@"
}

# Load flows.config.json (or FLOWS_CONFIG_FILE / --config path) into env vars used below.
# Existing env vars win over JSON (so CLI/CI can override). Missing config file is OK until a command needs values.
load_flows_config() {
  local config_file="${FLOWS_CONFIG_FILE:-${FLOWS_PACKAGE_ROOT}/flows.config.json}"
  if [[ ! -f "$config_file" ]]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 is required to read ${config_file}" >&2
    return 1
  fi
  # shellcheck disable=SC1090
  eval "$(
    FLOWS_CONFIG_FILE="$config_file" python3 - <<'PY'
import json, os, shlex
from pathlib import Path

path = Path(os.environ["FLOWS_CONFIG_FILE"])
data = json.loads(path.read_text(encoding="utf-8"))

def get(*keys, default=""):
    cur = data
    for k in keys:
        if not isinstance(cur, dict) or k not in cur:
            return default
        cur = cur[k]
    if cur is None:
        return default
    return cur

def emit(name, value):
    # Do not overwrite env already set by the caller.
    if os.environ.get(name):
        return
    if value is None or value == "":
        return
    if isinstance(value, bool):
        value = "true" if value else "false"
    else:
        value = str(value)
    print(f"{name}={shlex.quote(value)}")

source = data.get("source") or {}
dest = data.get("dest") or {}
pg = data.get("pg") or {}

emit("SOURCE_DATABASE_URL", source.get("databaseUrl") or data.get("sourceDatabaseUrl"))
emit("SOURCE_SCHEMA", source.get("schema") or data.get("sourceSchema"))
emit("DEST_DATABASE_URL", dest.get("databaseUrl") or data.get("destDatabaseUrl"))
emit("DEST_SCHEMA", dest.get("schema") or data.get("destSchema"))
emit("EXPORT_SCHEMA", data.get("exportSchema"))
emit("FLOWS_SNAPSHOT_DIR", data.get("snapshotDir"))
emit("CONTENT_ONLY", data.get("contentOnly"))
emit("PG_USE_DOCKER", pg.get("useDocker"))
emit("PG_CLIENT_IMAGE", pg.get("clientImage"))
emit("PG_DUMP_MIN_MAJOR", pg.get("dumpMinMajor"))
emit("PG_DOCKER_NETWORK", pg.get("dockerNetwork"))
emit("PG_DOCKER_HOST", pg.get("dockerHost"))
PY
  )"
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
    echo "ERROR: set source.databaseUrl in flows.config.json — required only for export." >&2
    echo "Copy flows.config.example.json → flows.config.json" >&2
    return 1
  fi
  echo "$url"
}

require_dest_url() {
  local url
  url="$(resolved_dest_database_url)"
  if [[ -z "$url" ]]; then
    echo "ERROR: set dest.databaseUrl in flows.config.json." >&2
    echo "On the production server this is local Postgres (no source block / no SSH needed)." >&2
    echo "Copy flows.config.example.json → flows.config.json" >&2
    return 1
  fi
  echo "$url"
}

flows_source_schema() {
  echo "${SOURCE_SCHEMA:-public}"
}

flows_dest_schema() {
  echo "${DEST_SCHEMA:-${TARGET_SCHEMA:-public}}"
}

# Schema written into the committed SQL snapshot (portable for prod apply).
flows_export_schema() {
  echo "${EXPORT_SCHEMA:-${TARGET_SCHEMA:-public}}"
}

resolved_snapshot_dir() {
  local dir="${FLOWS_SNAPSHOT_DIR:-${FLOWS_SNAPSHOT_DEFAULT}}"
  if [[ "$dir" != /* ]]; then
    dir="${FLOWS_PACKAGE_ROOT}/${dir}"
  fi
  echo "$dir"
}

require_snapshot_dir() {
  local dir
  dir="$(resolved_snapshot_dir)"
  if [[ ! -f "${dir}/directus_flows_operations.sql" ]]; then
    echo "ERROR: snapshot SQL missing: ${dir}/directus_flows_operations.sql" >&2
    echo "On a machine with source DB access, run: ./scripts/sync.sh export" >&2
    echo "Commit exports/, push, then pull on the prod server." >&2
    return 1
  fi
  if [[ ! -f "${dir}/fingerprints/flows.jsonl" || ! -f "${dir}/fingerprints/operations.jsonl" ]]; then
    echo "ERROR: snapshot fingerprints missing under ${dir}/fingerprints/ (flows.jsonl, operations.jsonl)" >&2
    echo "Re-run: ./scripts/sync.sh export" >&2
    return 1
  fi
  echo "$dir"
}

snapshot_export_schema() {
  local dir="$1"
  local schema=""
  if [[ -f "${dir}/MANIFEST" ]]; then
    schema="$(awk -F= '/^export_schema=/{print $2; exit}' "${dir}/MANIFEST")"
  fi
  if [[ -z "$schema" ]]; then
    schema="$(flows_export_schema)"
  fi
  echo "$schema"
}

# Prefer host psql for host-published Postgres. Docker client rewrites 127.0.0.1 → host.docker.internal.
flows_psql() {
  local url="$1"
  shift
  if [[ "${PG_USE_DOCKER:-}" != "true" ]] && command -v psql >/dev/null 2>&1; then
    flows_warn_url_password_encoding "$url"
    psql "$url" "$@"
    return
  fi
  if [[ "${PG_USE_DOCKER:-}" == "true" ]]; then
    echo "pg.useDocker=true → using Docker psql client" >&2
  elif ! command -v psql >/dev/null 2>&1; then
    echo "Host psql not found → using Docker psql client" >&2
  fi
  flows_psql_docker "$url" "$@"
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

normalize_flows_dump_sql() {
  local from_schema="$1"
  local to_schema="$2"
  sanitize_flows_dump_sql | rewrite_flows_dump_schema "$from_schema" "$to_schema"
}

# Export a stable JSONL fingerprint per row for compare (id + content fields).
# Uses options::jsonb so json vs jsonb storage / key-order / spacing does not create false diffs.
# JSONL avoids TSV breakage when options contain tabs/newlines (common in exec ops).
export_flows_fingerprint_tsv() {
  # Name kept for call-sites; output is JSONL (one json object per line).
  local url="$1"
  local schema="$2"
  local kind="$3" # flows | operations
  local content_only="${CONTENT_ONLY:-true}"

  if [[ "$kind" == "flows" ]]; then
    if [[ "$content_only" == "true" ]]; then
      flows_psql "$url" -v ON_ERROR_STOP=1 -At -c "
SELECT jsonb_build_object(
  'id', id::text,
  'name', coalesce(name, ''),
  'icon', coalesce(icon, ''),
  'color', coalesce(color, ''),
  'description', coalesce(description, ''),
  'status', coalesce(status, ''),
  'trigger', coalesce(trigger, ''),
  'accountability', coalesce(accountability, ''),
  'options', coalesce(options::jsonb, 'null'::jsonb),
  'operation', coalesce(operation::text, '')
)::text
FROM ${schema}.directus_flows
ORDER BY id;"
    else
      flows_psql "$url" -v ON_ERROR_STOP=1 -At -c "
SELECT jsonb_build_object(
  'id', id::text,
  'name', coalesce(name, ''),
  'icon', coalesce(icon, ''),
  'color', coalesce(color, ''),
  'description', coalesce(description, ''),
  'status', coalesce(status, ''),
  'trigger', coalesce(trigger, ''),
  'accountability', coalesce(accountability, ''),
  'options', coalesce(options::jsonb, 'null'::jsonb),
  'operation', coalesce(operation::text, ''),
  'date_created', coalesce(date_created::text, ''),
  'user_created', coalesce(user_created::text, '')
)::text
FROM ${schema}.directus_flows
ORDER BY id;"
    fi
  else
    if [[ "$content_only" == "true" ]]; then
      flows_psql "$url" -v ON_ERROR_STOP=1 -At -c "
SELECT jsonb_build_object(
  'id', id::text,
  'name', coalesce(name, ''),
  'key', coalesce(key, ''),
  'type', coalesce(type, ''),
  'position_x', position_x,
  'position_y', position_y,
  'options', coalesce(options::jsonb, 'null'::jsonb),
  'resolve', coalesce(resolve::text, ''),
  'reject', coalesce(reject::text, ''),
  'flow', flow::text
)::text
FROM ${schema}.directus_operations
ORDER BY id;"
    else
      flows_psql "$url" -v ON_ERROR_STOP=1 -At -c "
SELECT jsonb_build_object(
  'id', id::text,
  'name', coalesce(name, ''),
  'key', coalesce(key, ''),
  'type', coalesce(type, ''),
  'position_x', position_x,
  'position_y', position_y,
  'options', coalesce(options::jsonb, 'null'::jsonb),
  'resolve', coalesce(resolve::text, ''),
  'reject', coalesce(reject::text, ''),
  'flow', flow::text,
  'date_created', coalesce(date_created::text, ''),
  'user_created', coalesce(user_created::text, '')
)::text
FROM ${schema}.directus_operations
ORDER BY id;"
    fi
  fi
}

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
import json
import sys
from pathlib import Path

kind, src_path, dst_path, src_labels_path, dst_labels_path = sys.argv[1:6]

def load_rows(path: str):
    """Load JSONL fingerprints (preferred) or legacy TSV (best-effort)."""
    rows = {}
    text = Path(path).read_text(encoding="utf-8")
    for line in text.splitlines():
        if not line.strip():
            continue
        if line.lstrip().startswith("{"):
            obj = json.loads(line)
            rid = str(obj.get("id", ""))
            # Drop id from payload used for equality; keep stable key order via json dumps.
            payload = {k: obj[k] for k in obj.keys() if k != "id"}
            rows[rid] = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
            continue
        # Legacy TSV: id + tab-separated fields (fragile if fields contain tabs/newlines).
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
print(f"  snapshot: {len(src)}  dest: {len(dst)}  unchanged: {unchanged}")
print(f"  + added (snapshot only): {len(added)}")
print(f"  - removed (dest only):   {len(removed)}")
print(f"  ~ changed:               {len(changed)}")

# Hint for the historical false-diff: same ids, nearly all "changed" after a successful apply.
if (
    not added
    and not removed
    and changed
    and len(src) == len(dst)
    and len(changed) >= max(1, int(0.8 * len(src)))
):
    print(
        "  note: almost every row is ~changed with no add/remove — "
        "often json vs jsonb options::text formatting. "
        "Current tooling fingerprints via options::jsonb (JSONL)."
    )

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

sys.exit(0 if not (added or removed or changed) else 1)
PY
}

write_flows_snapshot() {
  local source_url="$1"
  local source_schema="$2"
  local export_schema="$3"
  local dir="$4"
  local stamp
  stamp="$(date +%Y%m%d_%H%M%S)"
  local flows_count ops_count

  mkdir -p "${dir}/fingerprints"

  echo "Exporting source flows/operations → snapshot ${dir}" >&2
  echo "  source_schema=${source_schema} → export_schema=${export_schema}" >&2

  {
    echo "-- Directus flows/operations snapshot (committed artifact)"
    echo "-- source_schema: ${source_schema}"
    echo "-- export_schema: ${export_schema}"
    echo "-- exported_at: ${stamp}"
    echo "-- Apply on prod: ./scripts/sync.sh apply"
    dump_flows_data_sql "$source_url" "$source_schema" \
      | normalize_flows_dump_sql "$source_schema" "$export_schema"
  } >"${dir}/directus_flows_operations.sql"

  export_flows_fingerprint_tsv "$source_url" "$source_schema" flows \
    >"${dir}/fingerprints/flows.jsonl"
  export_flows_fingerprint_tsv "$source_url" "$source_schema" operations \
    >"${dir}/fingerprints/operations.jsonl"
  export_flows_label_map "$source_url" "$source_schema" flows \
    >"${dir}/fingerprints/flows_labels.tsv"
  export_flows_label_map "$source_url" "$source_schema" operations \
    >"${dir}/fingerprints/operations_labels.tsv"
  # Remove legacy TSV fingerprints if present (replaced by JSONL).
  rm -f "${dir}/fingerprints/flows.tsv" "${dir}/fingerprints/operations.tsv"

  flows_count="$(wc -l <"${dir}/fingerprints/flows.jsonl" | tr -d '[:space:]')"
  ops_count="$(wc -l <"${dir}/fingerprints/operations.jsonl" | tr -d '[:space:]')"

  cat >"${dir}/MANIFEST" <<EOF
exported_at=${stamp}
source_schema=${source_schema}
export_schema=${export_schema}
flows_count=${flows_count}
operations_count=${ops_count}
content_only=${CONTENT_ONLY:-true}
sql_file=directus_flows_operations.sql
EOF

  if [[ ! -f "${dir}/README.md" ]]; then
    cat >"${dir}/README.md" <<'EOF'
# Directus flows snapshot (committed)

This directory is the **portable source snapshot** for production sync.

- **Commit** the files here after `./scripts/sync.sh export` (intentionally tracked).
- On the private prod server: `git pull`, configure `flows.config.json` (`dest` only), then `compare` / `apply` / `restore`.
- Runtime backups stay under `backups/` (gitignored).

See `docs/runbook.md`.
EOF
  fi

  echo "Snapshot written: flows=${flows_count} operations=${ops_count}" >&2
  echo "$dir"
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
Directus flows backup (runtime — gitignored under backups/)
created: ${stamp}
dest_schema: ${dest_schema}
files:
  directus_flows_operations.sql  — data-only dump (column-inserts)
  counts_flows.txt / counts_operations.txt — row counts at backup time

Restore:
  ./scripts/sync.sh restore ${stamp}
EOF

  echo "$dir"
}

# Replace dest flow tables from a committed/runtime SQL file (FK-safe).
apply_flows_from_sql_file() {
  local sql_file="$1"
  local from_schema="$2"
  local dest_url="$3"
  local dest_schema="$4"
  local tmp

  if [[ ! -f "$sql_file" ]]; then
    echo "ERROR: missing SQL file: ${sql_file}" >&2
    return 1
  fi

  tmp="$(mktemp -t bis-flows-apply.XXXXXX.sql)"
  {
    echo "BEGIN;"
    echo "SET LOCAL session_replication_role = replica;"
    echo "TRUNCATE TABLE ${dest_schema}.directus_operations, ${dest_schema}.directus_flows CASCADE;"
    # Re-normalize in case export_schema ≠ dest_schema, and strip PG17-only SETs again.
    sanitize_flows_dump_sql <"$sql_file" | rewrite_flows_dump_schema "$from_schema" "$dest_schema"
    echo "SET LOCAL session_replication_role = origin;"
    echo "COMMIT;"
  } >"$tmp"

  echo "Applying snapshot SQL → dest (${from_schema} → ${dest_schema})…" >&2
  flows_psql "$dest_url" -v ON_ERROR_STOP=1 -f - <"$tmp"
  rm -f "$tmp"

  local flows_n ops_n
  flows_n="$(flows_psql "$dest_url" -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM ${dest_schema}.directus_flows;")"
  ops_n="$(flows_psql "$dest_url" -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM ${dest_schema}.directus_operations;")"
  echo "Apply finished: dest now has flows=${flows_n} operations=${ops_n}" >&2
}

restore_flows_from_backup() {
  local dest_url="$1"
  local dest_schema="$2"
  local backup_dir="$3"
  local sql_file="${backup_dir}/directus_flows_operations.sql"

  apply_flows_from_sql_file "$sql_file" "$dest_schema" "$dest_url" "$dest_schema"
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
