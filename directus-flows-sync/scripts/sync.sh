#!/usr/bin/env bash
#
# Sync Directus flows + operations via a git-mediated snapshot.
#
# Two-machine workflow (no SSH):
#   1) Machine with source DB:  export  → commit exports/ → push
#   2) Private prod server:     git pull → compare / apply / restore (dest only)
#
# Default is dry-run (compare only). Never mutates destination without approval.
#
# Usage:
#   ./scripts/sync.sh export
#   ./scripts/sync.sh compare
#   ./scripts/sync.sh check-deps [--strict]
#   ./scripts/sync.sh backup
#   ./scripts/sync.sh apply [--approve]
#   ./scripts/sync.sh restore <backup-name-or-path>
#   ./scripts/sync.sh help
#
# Config: copy flows.config.example.json → flows.config.json (gitignored)
# Docs:   docs/runbook.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=db-flows-common.inc.sh
source "${SCRIPT_DIR}/db-flows-common.inc.sh"

load_flows_config

APPROVE=0
STRICT=0
OUT_PATH=""
COMMAND=""
BACKUP_NAME=""

usage() {
  cat <<'EOF'
sync.sh — Directus flows + operations (git-mediated snapshot)

Package: directus-flows-sync/ (self-contained)

Two-machine flow (primary):
  export   (needs source.*)  → commit exports/ → git push
  on prod: git pull → compare / apply / restore (needs dest.* only)

Commands:
  export               Dump source DB → exports/ (commit these files)
  compare              Diff committed snapshot vs live dest (default; no writes)
  check-deps           Scan snapshot options for external refs (collections, folders, URLs, …)
  backup               Backup destination flows/operations only (gitignored)
  apply                Compare, then replace dest from snapshot (needs approval)
  restore <name>       Restore dest from backups/<name>
  help                 Show this help

Options:
  --approve            Non-interactive approve for apply/restore
  --strict             With check-deps: exit 1 if dest is missing collections/folders
  --snapshot DIR       Snapshot directory (default: exports)
  --out DIR            Alias for --snapshot on export
  --config PATH        JSON config (default: flows.config.json)

JSON config (see flows.config.example.json):
  source.databaseUrl, source.schema    — export machine only
  exportSchema                         — schema written into snapshot SQL (default: public)
  dest.databaseUrl, dest.schema        — prod server (local Postgres)
  snapshotDir, contentOnly, pg.*       — optional
  pg.useDocker / pg.dockerHost / pg.dockerNetwork — Docker client ↔ host Postgres

Git hygiene:
  • Commit:   exports/ , flows.config.example.json
  • Ignore:   backups/ , flows.config.json

Safety:
  • Default is compare / dry-run only
  • apply always writes a dated backup under backups/ before mutate
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    compare|export|backup|apply|restore|check-deps|help|-h|--help)
      if [[ -z "$COMMAND" ]]; then
        if [[ "$1" == "-h" || "$1" == "--help" ]]; then
          COMMAND="help"
        else
          COMMAND="$1"
        fi
      else
        echo "ERROR: unexpected argument: $1" >&2
        exit 2
      fi
      shift
      ;;
    --approve)
      APPROVE=1
      shift
      ;;
    --strict)
      STRICT=1
      shift
      ;;
    --snapshot|--out)
      OUT_PATH="${2:?$1 needs a directory path}"
      FLOWS_SNAPSHOT_DIR="$OUT_PATH"
      shift 2
      ;;
    --config)
      FLOWS_CONFIG_FILE="${2:?--config needs a path}"
      load_flows_config
      shift 2
      ;;
    --env-file)
      echo "ERROR: --env-file is removed; use --config PATH (JSON)." >&2
      echo "See flows.config.example.json" >&2
      exit 2
      ;;
    *)
      if [[ "$COMMAND" == "restore" && -z "$BACKUP_NAME" ]]; then
        BACKUP_NAME="$1"
        shift
      else
        echo "ERROR: unknown argument: $1" >&2
        usage >&2
        exit 2
      fi
      ;;
  esac
done

COMMAND="${COMMAND:-compare}"

confirm_apply() {
  if [[ "$APPROVE" == "1" ]]; then
    echo "Approval: --approve flag set." >&2
    return 0
  fi
  if [[ ! -t 0 ]]; then
    echo "ERROR: non-interactive shell — re-run with --approve after reviewing compare output." >&2
    return 1
  fi
  local answer
  echo
  echo "This will REPLACE destination directus_flows + directus_operations"
  echo "with the committed snapshot under $(resolved_snapshot_dir)."
  echo "A backup will be taken first under backups/."
  printf "Type yes to continue: "
  read -r answer
  if [[ "$answer" != "yes" ]]; then
    echo "Aborted."
    return 1
  fi
}

cmd_export() {
  local source_url source_schema export_schema dir
  source_url="$(require_source_url)"
  source_schema="$(flows_source_schema)"
  export_schema="$(flows_export_schema)"
  dir="$(resolved_snapshot_dir)"

  write_flows_snapshot "$source_url" "$source_schema" "$export_schema" "$dir"
  echo
  echo "Next (on this machine):"
  echo "  git add exports/"
  echo "  git commit -m \"Update Directus flows snapshot\""
  echo "  git push"
  echo "Then on the prod server: git pull && ./scripts/sync.sh compare"
}

cmd_compare() {
  local dest_url dest_schema snap tmp
  local flows_rc=0 ops_rc=0
  snap="$(require_snapshot_dir)"
  dest_url="$(require_dest_url)"
  dest_schema="$(flows_dest_schema)"

  tmp="$(mktemp -d -t bis-flows-compare.XXXXXX)"
  echo "Comparing committed snapshot vs dest" >&2
  echo "  snapshot: ${snap}" >&2
  if [[ -f "${snap}/MANIFEST" ]]; then
    echo "  manifest: $(tr '\n' ' ' <"${snap}/MANIFEST")" >&2
  fi
  echo "  dest:     schema=${dest_schema}" >&2
  echo "  CONTENT_ONLY=${CONTENT_ONLY:-true}" >&2

  export_flows_fingerprint_tsv "$dest_url" "$dest_schema" flows >"${tmp}/dst_flows.jsonl"
  export_flows_fingerprint_tsv "$dest_url" "$dest_schema" operations >"${tmp}/dst_ops.jsonl"
  export_flows_label_map "$dest_url" "$dest_schema" flows >"${tmp}/dst_flows_labels.tsv"
  export_flows_label_map "$dest_url" "$dest_schema" operations >"${tmp}/dst_ops_labels.tsv"

  echo
  compare_fingerprint_files flows \
    "${snap}/fingerprints/flows.jsonl" "${tmp}/dst_flows.jsonl" \
    "${snap}/fingerprints/flows_labels.tsv" "${tmp}/dst_flows_labels.tsv" || flows_rc=$?
  echo
  compare_fingerprint_files operations \
    "${snap}/fingerprints/operations.jsonl" "${tmp}/dst_ops.jsonl" \
    "${snap}/fingerprints/operations_labels.tsv" "${tmp}/dst_ops_labels.tsv" || ops_rc=$?

  rm -rf "$tmp"

  if [[ "$flows_rc" -ne 0 || "$ops_rc" -ne 0 ]]; then
    echo
    case "${FLOWS_COMPARE_CONTEXT:-standalone}" in
      pre-apply)
        echo "Result: DIFFERENCES found — proceed only after approve."
        ;;
      post-apply)
        echo "Result: DIFFERENCES remain after apply."
        ;;
      *)
        echo "Result: DIFFERENCES found (dry-run — nothing written)."
        echo "Next: review above, then ./scripts/sync.sh apply   (or apply --approve)"
        ;;
    esac
    return 1
  fi
  echo
  echo "Result: snapshot and dest match for flows + operations."
  return 0
}

cmd_backup() {
  local dest_url dest_schema dir
  dest_url="$(require_dest_url)"
  dest_schema="$(flows_dest_schema)"
  dir="$(backup_dest_flows "$dest_url" "$dest_schema")"
  echo "Backup complete: ${dir}"
}

cmd_apply() {
  local dest_url dest_schema snap export_schema backup_dir
  snap="$(require_snapshot_dir)"
  dest_url="$(require_dest_url)"
  dest_schema="$(flows_dest_schema)"
  export_schema="$(snapshot_export_schema "$snap")"

  echo "=== Pre-apply compare (dry-run) ==="
  local cmp_rc=0
  FLOWS_COMPARE_CONTEXT=pre-apply cmd_compare || cmp_rc=$?
  if [[ "$cmp_rc" -eq 0 ]]; then
    # Fingerprints can falsely "match" if empty/corrupt; still check MANIFEST counts.
    local want_flows want_ops have_flows have_ops
    want_flows="$(awk -F= '/^flows_count=/{print $2; exit}' "${snap}/MANIFEST" 2>/dev/null || true)"
    want_ops="$(awk -F= '/^operations_count=/{print $2; exit}' "${snap}/MANIFEST" 2>/dev/null || true)"
    have_flows="$(flows_psql "$dest_url" -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM ${dest_schema}.directus_flows;")"
    have_ops="$(flows_psql "$dest_url" -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM ${dest_schema}.directus_operations;")"
    if [[ -n "$want_flows" && -n "$want_ops" && ( "$have_flows" != "$want_flows" || "$have_ops" != "$want_ops" ) ]]; then
      echo "Fingerprints match but dest counts (${have_flows}/${have_ops}) ≠ MANIFEST (${want_flows}/${want_ops}) — applying anyway." >&2
    else
      echo "Nothing to apply — already in sync."
      return 0
    fi
  fi

  confirm_apply

  backup_dir="$(backup_dest_flows "$dest_url" "$dest_schema")"
  echo "Pre-apply backup: ${backup_dir}"

  apply_flows_from_sql_file \
    "${snap}/directus_flows_operations.sql" \
    "$export_schema" \
    "$dest_url" \
    "$dest_schema"

  echo
  echo "=== Post-apply verify ==="
  local verify_rc=0
  FLOWS_COMPARE_CONTEXT=post-apply cmd_compare || verify_rc=$?
  if [[ "$verify_rc" -ne 0 ]]; then
    echo "WARNING: post-apply compare still reports differences." >&2
    echo "Restore with: ./scripts/sync.sh restore $(basename "$backup_dir")" >&2
    return 1
  fi
  echo "Apply complete. Backup kept at: ${backup_dir}"
  echo "Rollback: ./scripts/sync.sh restore $(basename "$backup_dir")"
}

cmd_check_deps() {
  local snap sql_file args=()
  local cols_file="" folders_file="" tmp=""
  snap="$(require_snapshot_dir)"
  sql_file="${snap}/directus_flows_operations.sql"

  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 is required for check-deps" >&2
    return 1
  fi

  args=("${SCRIPT_DIR}/check-deps.py" "$sql_file")

  # Optional live probe against dest (prod): flag missing collections / folders.
  local dest_url dest_schema
  dest_url="$(resolved_dest_database_url)"
  if [[ -n "$dest_url" ]]; then
    dest_schema="$(flows_dest_schema)"
    tmp="$(mktemp -d -t bis-flows-check-deps.XXXXXX)"
    cols_file="${tmp}/collections.txt"
    folders_file="${tmp}/folders.txt"
    echo "Probing dest for collections/folders (schema=${dest_schema})..." >&2
    if flows_psql "$dest_url" -v ON_ERROR_STOP=1 -At -c \
      "SELECT collection FROM ${dest_schema}.directus_collections ORDER BY 1;" \
      >"$cols_file" 2>/dev/null; then
      args+=(--collections-file "$cols_file")
    else
      echo "WARNING: could not list dest collections — snapshot-only scan." >&2
    fi
    if flows_psql "$dest_url" -v ON_ERROR_STOP=1 -At -c \
      "SELECT id::text FROM ${dest_schema}.directus_folders ORDER BY 1;" \
      >"$folders_file" 2>/dev/null; then
      args+=(--folders-file "$folders_file")
    else
      echo "WARNING: could not list dest folders — folder probe skipped." >&2
    fi
  else
    echo "No dest.databaseUrl — scanning committed snapshot only." >&2
  fi

  if [[ "$STRICT" == "1" ]]; then
    args+=(--strict)
  fi

  local rc=0
  python3 "${args[@]}" || rc=$?
  [[ -n "$tmp" ]] && rm -rf "$tmp"
  return "$rc"
}

cmd_restore() {
  local dest_url dest_schema dir
  if [[ -z "$BACKUP_NAME" ]]; then
    echo "ERROR: restore requires a backup name or path" >&2
    echo "Example: ./scripts/sync.sh restore 20261117_153000" >&2
    echo "Available under ${FLOWS_BACKUP_ROOT}:" >&2
    ls -1 "${FLOWS_BACKUP_ROOT}" 2>/dev/null || echo "(none yet)" >&2
    return 2
  fi
  dest_url="$(require_dest_url)"
  dest_schema="$(flows_dest_schema)"
  dir="$(resolve_backup_dir "$BACKUP_NAME")"

  if [[ "$APPROVE" != "1" ]]; then
    if [[ ! -t 0 ]]; then
      echo "ERROR: non-interactive restore needs --approve" >&2
      return 1
    fi
    local answer
    echo "Restore will REPLACE dest flows/operations from:"
    echo "  ${dir}"
    printf "Type yes to continue: "
    read -r answer
    if [[ "$answer" != "yes" ]]; then
      echo "Aborted."
      return 1
    fi
  fi

  local safety
  safety="$(backup_dest_flows "$dest_url" "$dest_schema" "$(date +%Y%m%d_%H%M%S)_pre_restore")"
  echo "Safety backup of current dest: ${safety}"

  restore_flows_from_backup "$dest_url" "$dest_schema" "$dir"
  echo "Restore complete from $(basename "$dir")."
}

case "$COMMAND" in
  help) usage ;;
  compare) cmd_compare ;;
  check-deps) cmd_check_deps ;;
  export) cmd_export ;;
  backup) cmd_backup ;;
  apply) cmd_apply ;;
  restore) cmd_restore ;;
  *)
    echo "ERROR: unknown command: ${COMMAND}" >&2
    usage >&2
    exit 2
    ;;
esac
