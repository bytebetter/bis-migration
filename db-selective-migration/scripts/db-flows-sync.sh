#!/usr/bin/env bash
#
# Sync Directus flows + operations: compare → approve → backup → apply → restore.
#
# Default is dry-run (compare only). Never mutates destination without approval.
#
# Usage:
#   ./scripts/db-flows-sync.sh compare
#   ./scripts/db-flows-sync.sh export [--side source|dest] [--out PATH]
#   ./scripts/db-flows-sync.sh backup
#   ./scripts/db-flows-sync.sh apply [--approve]
#   ./scripts/db-flows-sync.sh restore <backup-name-or-path>
#   ./scripts/db-flows-sync.sh help
#
# Config: copy docker/flows.env.example → .env.flows (gitignored)
# Docs:   docs/directus-flows-sync-runbook.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=db-flows-common.inc.sh
source "${SCRIPT_DIR}/db-flows-common.inc.sh"

load_flows_env_file
trap flows_cleanup_on_exit EXIT

APPROVE=0
SIDE="source"
OUT_PATH=""
COMMAND=""
BACKUP_NAME=""

usage() {
  cat <<'EOF'
db-flows-sync.sh — Directus flows + operations sync (source → destination)

Commands:
  compare              Diff source vs dest (default; no writes)
  export               Dump data-only SQL for flows/operations
  backup               Backup destination flows/operations only
  apply                Compare, then replace dest with source (needs approval)
  restore <name>       Restore dest from backups/flows/<name>
  help                 Show this help

Options:
  --approve            Non-interactive approve for apply (after you reviewed compare)
  --side source|dest   Side for export (default: source)
  --out PATH           Output path for export
  --env-file PATH      Load env from PATH instead of .env.flows

Environment (see docker/flows.env.example):
  SOURCE_DATABASE_URL, SOURCE_SCHEMA
  DEST_DATABASE_URL, DEST_SCHEMA
  DEST_SSH_HOST (+ DEST_SSH_LOCAL_PORT, …) optional tunnel
  CONTENT_ONLY=true|false  compare ignores date_created/user_created when true (default)

Safety:
  • Default is compare / dry-run only
  • apply always writes a dated backup under backups/flows/ before mutate
  • Do not point DEST at production until you intend to; this tooling does not auto-target prod
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    compare|export|backup|apply|restore|help|-h|--help)
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
    --side)
      SIDE="${2:?--side needs source|dest}"
      shift 2
      ;;
    --out)
      OUT_PATH="${2:?--out needs a path}"
      shift 2
      ;;
    --env-file)
      FLOWS_ENV_FILE="${2:?--env-file needs a path}"
      load_flows_env_file
      shift 2
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
  echo "This will REPLACE destination directus_flows + directus_operations with source."
  echo "A backup will be taken first under backups/flows/."
  printf "Type yes to continue: "
  read -r answer
  if [[ "$answer" != "yes" ]]; then
    echo "Aborted."
    return 1
  fi
}

cmd_compare() {
  local source_url dest_url source_schema dest_schema
  local tmp diff_status=0
  source_url="$(require_source_url)"
  dest_url="$(require_dest_url)"
  source_schema="$(flows_schema_for_side source)"
  dest_schema="$(flows_schema_for_side dest)"

  flows_ssh_tunnel_start

  tmp="$(mktemp -d -t bis-flows-compare.XXXXXX)"
  echo "Comparing flows/operations" >&2
  echo "  source: schema=${source_schema}" >&2
  echo "  dest:   schema=${dest_schema}" >&2
  echo "  CONTENT_ONLY=${CONTENT_ONLY:-true}" >&2

  export_flows_fingerprint_tsv "$source_url" "$source_schema" flows >"${tmp}/src_flows.tsv"
  export_flows_fingerprint_tsv "$dest_url" "$dest_schema" flows >"${tmp}/dst_flows.tsv"
  export_flows_fingerprint_tsv "$source_url" "$source_schema" operations >"${tmp}/src_ops.tsv"
  export_flows_fingerprint_tsv "$dest_url" "$dest_schema" operations >"${tmp}/dst_ops.tsv"
  export_flows_label_map "$source_url" "$source_schema" flows >"${tmp}/src_flows_labels.tsv"
  export_flows_label_map "$dest_url" "$dest_schema" flows >"${tmp}/dst_flows_labels.tsv"
  export_flows_label_map "$source_url" "$source_schema" operations >"${tmp}/src_ops_labels.tsv"
  export_flows_label_map "$dest_url" "$dest_schema" operations >"${tmp}/dst_ops_labels.tsv"

  echo
  # Do not toggle `set -e` here — that would leak into callers (e.g. apply).
  local flows_rc=0
  local ops_rc=0
  compare_fingerprint_files flows \
    "${tmp}/src_flows.tsv" "${tmp}/dst_flows.tsv" \
    "${tmp}/src_flows_labels.tsv" "${tmp}/dst_flows_labels.tsv" || flows_rc=$?
  echo
  compare_fingerprint_files operations \
    "${tmp}/src_ops.tsv" "${tmp}/dst_ops.tsv" \
    "${tmp}/src_ops_labels.tsv" "${tmp}/dst_ops_labels.tsv" || ops_rc=$?

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
        echo "Next: review above, then ./scripts/db-flows-sync.sh apply   (or apply --approve)"
        ;;
    esac
    return 1
  fi
  echo
  echo "Result: source and dest match for flows + operations."
  return 0
}

cmd_export() {
  local url schema stamp out
  if [[ "$SIDE" != "source" && "$SIDE" != "dest" ]]; then
    echo "ERROR: --side must be source or dest" >&2
    return 2
  fi
  if [[ "$SIDE" == "source" ]]; then
    url="$(require_source_url)"
  else
    url="$(require_dest_url)"
    flows_ssh_tunnel_start
  fi
  schema="$(flows_schema_for_side "$SIDE")"
  stamp="$(date +%Y%m%d_%H%M%S)"
  out="${OUT_PATH:-${FLOWS_PACKAGE_ROOT}/backups/flows/export_${SIDE}_${stamp}.sql}"
  mkdir -p "$(dirname "$out")"

  echo "Exporting ${SIDE} flows/operations (${schema}) → ${out}" >&2
  {
    echo "-- Directus flows/operations data-only export"
    echo "-- side: ${SIDE}  schema: ${schema}  at: ${stamp}"
    dump_flows_data_sql "$url" "$schema" | sanitize_flows_dump_sql
  } >"$out"
  echo "Done. Size: $(du -h "$out" | cut -f1)" >&2
}

cmd_backup() {
  local dest_url dest_schema dir
  dest_url="$(require_dest_url)"
  dest_schema="$(flows_schema_for_side dest)"
  flows_ssh_tunnel_start
  dir="$(backup_dest_flows "$dest_url" "$dest_schema")"
  echo "Backup complete: ${dir}"
}

cmd_apply() {
  local source_url dest_url source_schema dest_schema backup_dir
  source_url="$(require_source_url)"
  dest_url="$(require_dest_url)"
  source_schema="$(flows_schema_for_side source)"
  dest_schema="$(flows_schema_for_side dest)"

  flows_ssh_tunnel_start

  echo "=== Pre-apply compare (dry-run) ==="
  local cmp_rc=0
  FLOWS_COMPARE_CONTEXT=pre-apply cmd_compare || cmp_rc=$?
  if [[ "$cmp_rc" -eq 0 ]]; then
    echo "Nothing to apply — already in sync."
    return 0
  fi

  confirm_apply

  backup_dir="$(backup_dest_flows "$dest_url" "$dest_schema")"
  echo "Pre-apply backup: ${backup_dir}"

  apply_flows_from_source "$source_url" "$source_schema" "$dest_url" "$dest_schema"

  echo
  echo "=== Post-apply verify ==="
  local verify_rc=0
  FLOWS_COMPARE_CONTEXT=post-apply cmd_compare || verify_rc=$?
  if [[ "$verify_rc" -ne 0 ]]; then
    echo "WARNING: post-apply compare still reports differences." >&2
    echo "Restore with: ./scripts/db-flows-sync.sh restore $(basename "$backup_dir")" >&2
    return 1
  fi
  echo "Apply complete. Backup kept at: ${backup_dir}"
  echo "Rollback: ./scripts/db-flows-sync.sh restore $(basename "$backup_dir")"
}

cmd_restore() {
  local dest_url dest_schema dir
  if [[ -z "$BACKUP_NAME" ]]; then
    echo "ERROR: restore requires a backup name or path" >&2
    echo "Example: ./scripts/db-flows-sync.sh restore 20261117_153000" >&2
    echo "Available under ${FLOWS_BACKUP_ROOT}:" >&2
    ls -1 "${FLOWS_BACKUP_ROOT}" 2>/dev/null || echo "(none yet)" >&2
    return 2
  fi
  dest_url="$(require_dest_url)"
  dest_schema="$(flows_schema_for_side dest)"
  dir="$(resolve_backup_dir "$BACKUP_NAME")"

  flows_ssh_tunnel_start

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

  # Safety backup of current dest before restore
  local safety
  safety="$(backup_dest_flows "$dest_url" "$dest_schema" "$(date +%Y%m%d_%H%M%S)_pre_restore")"
  echo "Safety backup of current dest: ${safety}"

  restore_flows_from_backup "$dest_url" "$dest_schema" "$dir"
  echo "Restore complete from $(basename "$dir")."
}

case "$COMMAND" in
  help) usage ;;
  compare) cmd_compare ;;
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
