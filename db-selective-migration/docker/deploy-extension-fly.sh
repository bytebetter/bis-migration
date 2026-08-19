#!/usr/bin/env bash
set -euo pipefail

FLY_APP="${FLY_APP:-bis-backoffice-dev}"
REMOTE_EXTENSIONS_DIR="${DIRECTUS_EXTENSIONS_DIR:-/directus/data/extensions}"
REMOTE_BACKUP_DIR="${DIRECTUS_EXTENSIONS_BACKUP_DIR:-/directus/data/extensions-backup}"
KEEP_BACKUPS="${DIRECTUS_EXTENSIONS_KEEP_BACKUPS:-5}"
HEALTH_URL="${DIRECTUS_HEALTH_URL:-https://${FLY_APP}.fly.dev/server/health}"
HEALTH_TRIES="${DIRECTUS_HEALTH_TRIES:-12}"
HEALTH_SLEEP="${DIRECTUS_HEALTH_SLEEP:-8}"

usage() {
  cat <<'EOF'
Deploy a Directus extension to Fly.io (volume at /directus/data/extensions).

Usage:
  deploy-extension-fly.sh deploy <extension-directory> [--no-restart]
  deploy-extension-fly.sh list
  deploy-extension-fly.sh list-backups <extension-name>
  deploy-extension-fly.sh rollback <extension-name> [backup-timestamp] [--no-restart]

Examples:
  ./deploy-extension-fly.sh deploy ../directus-extensions-bb-dev/bis-report
  ./deploy-extension-fly.sh list
  ./deploy-extension-fly.sh list-backups bis-report
  ./deploy-extension-fly.sh rollback bis-report 20260817-124139

Environment:
  FLY_APP                          Fly app name (default: bis-backoffice-dev)
  DIRECTUS_EXTENSIONS_DIR          Remote extensions dir (default: /directus/data/extensions)
  DIRECTUS_EXTENSIONS_BACKUP_DIR   Remote backup dir (default: /directus/data/extensions-backup)
  DIRECTUS_EXTENSIONS_KEEP_BACKUPS Number of backups to keep per extension (default: 5)
  DIRECTUS_HEALTH_URL              Health URL after restart
EOF
}

log() {
  printf '[deploy-extension-fly] %s\n' "$*"
}

die() {
  printf '[deploy-extension-fly] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

require_safe_name() {
  [[ "$1" =~ ^[a-zA-Z0-9._-]+$ ]] || die "invalid extension name: $1"
}

fly_filter() {
  grep -v -e 'Metrics token unavailable' -e '^Warning: Metrics' -e '^Connecting to ' || true
}

fly_ssh() {
  local remote_cmd="$1" out
  out="$(fly ssh console -a "$FLY_APP" -C "sh -c $(python3 -c 'import shlex,sys; print(shlex.quote(sys.argv[1]))' "$remote_cmd")" 2> >(fly_filter >&2))"
  printf '%s\n' "$out" | grep -v '^Connecting to ' || true
}

validate_extension_dir() {
  local dir="$1"
  local package_json="$dir/package.json"

  [[ -d "$dir" ]] || die "extension directory not found: $dir"
  [[ -f "$package_json" ]] || die "missing package.json in $dir"

  python3 - "$package_json" "$dir" <<'PY' || die "invalid package.json in $dir"
import json
import sys
from pathlib import Path

pkg_path = Path(sys.argv[1])
root = Path(sys.argv[2])
data = json.loads(pkg_path.read_text(encoding="utf-8"))
ext = data.get("directus:extension") or {}
path = ext.get("path")
if not path:
    raise SystemExit("package.json missing directus:extension.path")

paths = list(path.values()) if isinstance(path, dict) else [path]
missing = [p for p in paths if not (root / p).is_file()]
if missing:
    raise SystemExit("missing built file(s): " + ", ".join(missing))

print(data.get("name") or root.name)
print(data.get("version") or "?")
print(ext.get("type") or "?")
print(",".join(paths))
PY
}

started_machine_id() {
  local json
  json="$(fly machines list -a "$FLY_APP" --json 2> >(fly_filter >&2))"
  python3 -c '
import json, sys
machines = json.loads(sys.argv[1])
started = [m for m in machines if m.get("state") == "started"]
candidates = started or machines
if not candidates:
    raise SystemExit("no Fly machines found")
print(candidates[0]["id"])
' "$json"
}

wait_health() {
  local i code
  for i in $(seq 1 "$HEALTH_TRIES"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || true)"
    log "health try $i: $code"
    if [[ "$code" == "200" ]]; then
      curl -s "$HEALTH_URL" || true
      printf '\n'
      return 0
    fi
    sleep "$HEALTH_SLEEP"
  done
  die "Directus health check failed: $HEALTH_URL"
}

restart_and_wait() {
  local machine_id="$1"
  log "restarting machine $machine_id"
  fly machine restart "$machine_id" -a "$FLY_APP" 2> >(fly_filter >&2)
  wait_health
  fly logs -a "$FLY_APP" --no-tail 2> >(fly_filter >&2) | grep -i 'Loaded extensions' | tail -n 1 || true
}

prune_remote_backups() {
  local name="$1"
  fly_ssh "ls -1dt ${REMOTE_BACKUP_DIR}/${name}-* 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do rm -rf \"\$old\"; echo removed_old_backup \$old; done" >/dev/null || true
}

cmd_list() {
  fly_ssh "ls -1 ${REMOTE_EXTENSIONS_DIR} 2>/dev/null | grep -v '^\.staging-' || true"
}

cmd_list_backups() {
  local name="$1"
  require_safe_name "$name"
  fly_ssh "ls -1dt ${REMOTE_BACKUP_DIR}/${name}-* 2>/dev/null | sed 's|.*/${name}-||' || true"
}

cmd_deploy() {
  local source_dir="${1:-}"
  local no_restart="${2:-}"

  [[ -n "$source_dir" ]] || die "extension directory is required"
  [[ -d "$source_dir" ]] || die "source directory not found: $source_dir"

  local source_abs name version ext_type dist_paths ts machine_id
  source_abs="$(cd "$source_dir" && pwd)"
  name="$(basename "$source_abs")"
  require_safe_name "$name"

  local meta
  meta="$(validate_extension_dir "$source_abs")"
  version="$(printf '%s\n' "$meta" | sed -n '2p')"
  ext_type="$(printf '%s\n' "$meta" | sed -n '3p')"
  dist_paths="$(printf '%s\n' "$meta" | sed -n '4p')"
  log "validated $name v${version} ($ext_type: $dist_paths)"

  ts="$(date +%Y%m%d-%H%M%S)"
  log "backing up remote $name (if present)"
  fly_ssh "mkdir -p '${REMOTE_BACKUP_DIR}' && if [ -d '${REMOTE_EXTENSIONS_DIR}/${name}' ]; then cp -a '${REMOTE_EXTENSIONS_DIR}/${name}' '${REMOTE_BACKUP_DIR}/${name}-${ts}' && echo backed_up ${name}-${ts}; else echo no_existing; fi"
  prune_remote_backups "$name"

  log "uploading $source_abs -> ${REMOTE_EXTENSIONS_DIR}/${name}"
  fly_ssh "rm -rf '${REMOTE_EXTENSIONS_DIR}/${name}'"
  fly ssh sftp put -a "$FLY_APP" -R "$source_abs" "${REMOTE_EXTENSIONS_DIR}/${name}" 2> >(fly_filter >&2)
  fly_ssh "chown -R node:node '${REMOTE_EXTENSIONS_DIR}/${name}' && echo chowned && ls -la '${REMOTE_EXTENSIONS_DIR}/${name}' && ls -la '${REMOTE_EXTENSIONS_DIR}/${name}/dist'"

  if [[ "$no_restart" == "--no-restart" ]]; then
    log "skipped restart (--no-restart); Directus may auto-reload if EXTENSIONS_AUTO_RELOAD=true"
    return 0
  fi

  machine_id="$(started_machine_id)"
  restart_and_wait "$machine_id"
  log "deployed $name v${version}"
}

cmd_rollback() {
  local name="${1:-}"
  local ts="${2:-}"
  local no_restart=""

  [[ -n "$name" ]] || die "extension name is required"
  require_safe_name "$name"

  if [[ "${ts:-}" == "--no-restart" ]]; then
    no_restart="--no-restart"
    ts=""
  elif [[ "${3:-}" == "--no-restart" ]]; then
    no_restart="--no-restart"
  fi

  local backup_path
  if [[ -n "$ts" ]]; then
    require_safe_name "$ts"
    backup_path="${REMOTE_BACKUP_DIR}/${name}-${ts}"
  else
    backup_path="$(fly_ssh "ls -1dt ${REMOTE_BACKUP_DIR}/${name}-* 2>/dev/null | head -n 1" | tr -d '\r' | tail -n 1)"
  fi
  [[ -n "$backup_path" ]] || die "backup not found for $name"

  log "rolling back $name from $backup_path"
  fly_ssh "test -d '$backup_path' || { echo 'backup not found: $backup_path'; exit 1; }; rm -rf '${REMOTE_EXTENSIONS_DIR}/${name}'; cp -a '$backup_path' '${REMOTE_EXTENSIONS_DIR}/${name}'; chown -R node:node '${REMOTE_EXTENSIONS_DIR}/${name}'; echo rolled_back"

  if [[ "$no_restart" == "--no-restart" ]]; then
    log "skipped restart (--no-restart)"
    return 0
  fi

  restart_and_wait "$(started_machine_id)"
}

main() {
  require_cmd fly
  require_cmd python3
  require_cmd curl
  require_cmd date

  fly auth whoami >/dev/null 2> >(fly_filter >&2) || die "not logged in to Fly.io (run: fly auth login)"

  local cmd="${1:-}"
  shift || true

  case "$cmd" in
    deploy)
      cmd_deploy "${1:-}" "${2:-}"
      ;;
    list)
      cmd_list
      ;;
    list-backups)
      cmd_list_backups "${1:-}"
      ;;
    rollback)
      cmd_rollback "${1:-}" "${2:-}" "${3:-}"
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
