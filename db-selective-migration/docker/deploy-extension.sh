#!/usr/bin/env bash
set -euo pipefail

EXTENSIONS_DIR="${DIRECTUS_EXTENSIONS_DIR:-/opt/bis/directus-extensions}"
BACKUP_DIR="${DIRECTUS_EXTENSIONS_BACKUP_DIR:-/opt/bis/directus-extensions-backup}"
KEEP_BACKUPS="${DIRECTUS_EXTENSIONS_KEEP_BACKUPS:-5}"

usage() {
  cat <<'EOF'
Deploy Directus extensions to a host directory (no Directus restart).

Usage:
  deploy-extension.sh deploy <extension-name> <artifact.zip>
  deploy-extension.sh deploy-dir <extension-name> <source-directory>
  deploy-extension.sh rollback <extension-name> [backup-timestamp]
  deploy-extension.sh list
  deploy-extension.sh list-backups <extension-name>
  deploy-extension.sh seed [source-directory]

Environment:
  DIRECTUS_EXTENSIONS_DIR          Target extensions directory (default: /opt/bis/directus-extensions)
  DIRECTUS_EXTENSIONS_BACKUP_DIR   Backup directory (default: /opt/bis/directus-extensions-backup)
  DIRECTUS_EXTENSIONS_KEEP_BACKUPS Number of backups to keep per extension (default: 5)

Zip layout (either):
  bis-api/package.json
  bis-api/dist/index.js

  or (root folder name must match <extension-name>):
  package.json
  dist/index.js
EOF
}

log() {
  printf '[deploy-extension] %s\n' "$*"
}

die() {
  printf '[deploy-extension] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

validate_extension_dir() {
  local name="$1"
  local dir="$2"

  [[ -d "$dir" ]] || die "extension directory not found: $dir"

  local package_json="$dir/package.json"
  [[ -f "$package_json" ]] || die "missing package.json in $dir"

  local dist_rel
  dist_rel="$(python3 - "$package_json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as fp:
    data = json.load(fp)

ext = data.get("directus:extension", {})
path = ext.get("path")
if not path:
    raise SystemExit("package.json missing directus:extension.path")

print(path)
PY
)" || die "invalid package.json in $dir"

  [[ -f "$dir/$dist_rel" ]] || die "missing built file: $dir/$dist_rel"
  log "validated $name ($dist_rel)"
}

backup_extension() {
  local name="$1"
  local target="$EXTENSIONS_DIR/$name"

  [[ -d "$target" ]] || return 0

  mkdir -p "$BACKUP_DIR"
  local ts
  ts="$(date +%Y%m%d-%H%M%S)"
  local backup_path="$BACKUP_DIR/${name}-${ts}"

  cp -a "$target" "$backup_path"
  log "backup saved: $backup_path"

  ls -1dt "$BACKUP_DIR/${name}-"* 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | while read -r old; do
    rm -rf "$old"
    log "removed old backup: $old"
  done

  printf '%s\n' "$ts"
}

resolve_zip_root() {
  local zip_file="$1"
  local expected_name="$2"
  local workdir="$3"

  unzip -q "$zip_file" -d "$workdir"

  if [[ -f "$workdir/package.json" ]]; then
    printf '%s\n' "$workdir"
    return 0
  fi

  if [[ -d "$workdir/$expected_name/package.json" ]]; then
    printf '%s\n' "$workdir/$expected_name"
    return 0
  fi

  local candidates=()
  while IFS= read -r pkg; do
    candidates+=("$(dirname "$pkg")")
  done < <(find "$workdir" -mindepth 1 -maxdepth 2 -name package.json | sort)

  if [[ "${#candidates[@]}" -eq 1 ]]; then
    printf '%s\n' "${candidates[0]}"
    return 0
  fi

  die "could not determine extension root inside zip (expected $expected_name/)"
}

deploy_dir() {
  local name="$1"
  local source_dir="$2"

  [[ -n "$name" ]] || die "extension name is required"
  [[ -d "$source_dir" ]] || die "source directory not found: $source_dir"

  local source_abs
  source_abs="$(cd "$source_dir" && pwd)"
  validate_extension_dir "$name" "$source_abs"

  mkdir -p "$EXTENSIONS_DIR"
  backup_extension "$name" >/dev/null

  local staging="$EXTENSIONS_DIR/.staging-${name}-$$"
  rm -rf "$staging"
  mkdir -p "$staging"
  cp -a "$source_abs/." "$staging/"
  validate_extension_dir "$name" "$staging"

  rm -rf "$EXTENSIONS_DIR/$name"
  mv "$staging" "$EXTENSIONS_DIR/$name"

  log "deployed $name -> $EXTENSIONS_DIR/$name"
  log "Directus will pick up changes after its automatic restart/reload cycle"
}

deploy_zip() {
  local name="$1"
  local zip_file="$2"

  [[ -f "$zip_file" ]] || die "zip file not found: $zip_file"

  (
    local workdir
    workdir="$(mktemp -d)"
    trap 'rm -rf "$workdir"' EXIT

    local resolved
    resolved="$(resolve_zip_root "$zip_file" "$name" "$workdir")"
    deploy_dir "$name" "$resolved"
  )
}

cmd_rollback() {
  local name="$1"
  local ts="${2:-}"

  [[ -n "$name" ]] || die "extension name is required"

  local backup_path
  if [[ -n "$ts" ]]; then
    backup_path="$BACKUP_DIR/${name}-${ts}"
  else
    backup_path="$(ls -1dt "$BACKUP_DIR/${name}-"* 2>/dev/null | head -n 1 || true)"
  fi

  [[ -n "$backup_path" && -d "$backup_path" ]] || die "backup not found for $name"

  mkdir -p "$EXTENSIONS_DIR"
  rm -rf "$EXTENSIONS_DIR/$name"
  cp -a "$backup_path" "$EXTENSIONS_DIR/$name"
  validate_extension_dir "$name" "$EXTENSIONS_DIR/$name"

  log "rolled back $name from $backup_path"
}

cmd_list() {
  mkdir -p "$EXTENSIONS_DIR"
  local dir name
  for dir in "$EXTENSIONS_DIR"/*; do
    [[ -d "$dir" ]] || continue
    name="$(basename "$dir")"
    [[ "$name" == .staging-* ]] && continue
    printf '%s\n' "$name"
  done | sort
}

cmd_list_backups() {
  local name="$1"
  [[ -n "$name" ]] || die "extension name is required"
  ls -1dt "$BACKUP_DIR/${name}-"* 2>/dev/null | sed "s|.*/${name}-||" || true
}

cmd_seed() {
  local source_dir="${1:-../directus-extensions-bb-dev}"
  [[ -d "$source_dir" ]] || die "source directory not found: $source_dir"

  local source_abs
  source_abs="$(cd "$source_dir" && pwd)"

  log "seeding extensions from $source_abs -> $EXTENSIONS_DIR"
  mkdir -p "$EXTENSIONS_DIR"

  local dir
  for dir in "$source_abs"/*; do
    [[ -d "$dir" ]] || continue
    [[ -f "$dir/package.json" ]] || continue
    deploy_dir "$(basename "$dir")" "$dir"
  done
}

main() {
  require_cmd python3
  require_cmd unzip
  require_cmd cp
  require_cmd find

  local cmd="${1:-}"
  shift || true

  case "$cmd" in
    deploy)
      deploy_zip "${1:-}" "${2:-}"
      ;;
    deploy-dir)
      deploy_dir "${1:-}" "${2:-}"
      ;;
    rollback)
      cmd_rollback "${1:-}" "${2:-}"
      ;;
    list)
      cmd_list
      ;;
    list-backups)
      cmd_list_backups "${1:-}"
      ;;
    seed)
      cmd_seed "${1:-}"
      ;;
    -h|--help|help|"")
      usage
      ;;
    *)
      die "unknown command: $cmd"
      ;;
  esac
}

main "$@"
